import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, getMeta, setMeta } from './db.js';
import { getDbFile } from './paths.js';
import { HttpError, badRequest, notFound, optionalString, requireString } from './util.js';
import { CorruptionError } from './storage.js';
import {
  listTables,
  listPartitions,
  listVersions,
  getVersion,
  listCommits,
  commitFiles,
  requireTable,
  requirePartition,
  buildManifest,
  latestVersion,
  versionAt,
  getVersionBySeq,
} from './tables.js';
import { diffPartition, computeImpact } from './diff.js';
import { inspectPage, listPartitionFiles, readObject } from './storage.js';
import {
  createRestoreJob,
  getJob,
  listJobs,
  listJobFiles,
  resolveConflict,
  cancelJob,
  resumeJob,
  jobProgress,
  recoverInterruptedJobs,
  rollbackApplied,
} from './restore.js';
import { listEvents, verifyAuditChain, recordEvent } from './audit.js';
import { seedDatabase, isSeeded, corruptObjectForDemo } from './seed.js';
import { partitionLockMap } from './locks.js';
import { readPage } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...SECURITY_HEADERS,
  });
  res.end(payload);
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
    return;
  }
  if (err instanceof CorruptionError) {
    sendJson(res, 409, { error: { code: 'object_corrupt', message: err.message, details: null } });
    return;
  }
  console.error('[timevault] unhandled error:', err);
  sendJson(res, 500, { error: { code: 'internal_error', message: '服务器内部错误', details: process.env.TV_DEBUG ? String(err?.stack ?? err) : null } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new HttpError(413, 'payload_too_large', '请求体超过 5 MiB');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('请求体必须是合法 JSON');
  }
}

function actorFrom(req, body) {
  const header = req.headers['x-operator'];
  const raw = typeof header === 'string' && header.trim() ? header : body?.operator;
  return optionalString(raw, 'operator', { max: 80 });
}

/* ------------------------------------------------------------------ */
/* Route table                                                         */
/* ------------------------------------------------------------------ */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  // `:name` matches one path segment; `*name` matches the rest of the path so
  // file paths containing slashes can be addressed.
  const escaped = pattern
    .replace(/\//g, '\\/')
    .replace(/\*(\w+)/g, (_, key) => {
      keys.push(key);
      return '(.*)';
    })
    .replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  const regex = new RegExp(`^${escaped}$`);
  routes.push({ method, regex, keys, handler, pattern });
}

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.regex);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { handler: r.handler, params };
    }
  }
  return null;
}

/* ---- health & bootstrap ---- */

route('GET', '/api/health', () => ({
  ok: true,
  seeded: isSeeded(),
  time: new Date().toISOString(),
  version: getMeta('schema_version', '1'),
}));

route('POST', '/api/admin/seed', async (ctx) => {
  const body = await readBody(ctx.req);
  const result = seedDatabase({ force: body.force === true });
  return { status: 200, body: result };
});

route('POST', '/api/admin/corrupt', async (ctx) => {
  const body = await readBody(ctx.req);
  const result = corruptObjectForDemo({ tableId: body.tableId, partition: body.partition, versionSeq: body.versionSeq });
  if (!result.ok) throw badRequest(`无法制造损坏样本: ${result.reason}`);
  recordEvent({
    actor: actorFrom(ctx.req, body) ?? '演示',
    action: 'system.object_corrupted',
    entityType: 'version',
    entityId: String(result.versionSeq),
    tableId: body.tableId ?? 'tbl_orders',
    reason: '故障演练：模拟对象损坏',
    evidence: `损坏对象 ${result.checksum.slice(0, 12)}`,
    snapshot: result,
  });
  return { status: 200, body: result };
});

/* ---- tables ---- */

route('GET', '/api/tables', () => {
  const tables = listTables();
  return {
    status: 200,
    body: {
      tables: tables.map((t) => {
        const partitions = listPartitions(t.id);
        const versions = listVersions(t.id, { limit: 1 });
        const locks = partitionLockMap(t.id);
        return {
          ...t,
          partitionCount: partitions.length,
          latestVersion: versions[0] ?? null,
          activeRestores: locks.size,
        };
      }),
    },
  };
});

route('GET', '/api/tables/:id', (ctx) => {
  const table = requireTable(ctx.params.id);
  const partitions = listPartitions(table.id);
  const locks = partitionLockMap(table.id);
  const versions = listVersions(table.id);
  const commits = listCommits(table.id, { limit: 40 });
  return {
    status: 200,
    body: {
      table,
      partitions: partitions.map((p) => ({ ...p, lock: locks.get(p.id) ?? null })),
      versions,
      commits,
      latest: versions[0] ?? null,
    },
  };
});

route('GET', '/api/tables/:id/versions', (ctx) => {
  requireTable(ctx.params.id);
  return { status: 200, body: { versions: listVersions(ctx.params.id) } };
});

route('GET', '/api/tables/:id/versions/:versionId', (ctx) => {
  const version = getVersion(ctx.params.versionId);
  if (!version || version.tableId !== ctx.params.id) throw notFound('版本不存在');
  return { status: 200, body: { version } };
});

route('GET', '/api/tables/:id/resolve', (ctx) => {
  requireTable(ctx.params.id);
  const { at, seq, versionId } = ctx.query;
  let version = null;
  if (versionId) version = getVersion(versionId);
  else if (seq) version = getVersionBySeq(ctx.params.id, Number(seq));
  else if (at) version = versionAt(ctx.params.id, new Date(at).toISOString());
  return { status: 200, body: { version } };
});

route('GET', '/api/tables/:id/partitions/:partition/files', (ctx) => {
  const table = requireTable(ctx.params.id);
  const partition = requirePartition(table.id, ctx.params.partition);
  const files = listPartitionFiles(partition.name).map((rel) => {
    const page = inspectPage(partition.name, rel);
    return { path: rel, bytes: page.bytes, checksum: page.checksum };
  });
  return { status: 200, body: { partition, files } };
});

route('GET', '/api/tables/:id/partitions/:partition/preview', (ctx) => {
  const table = requireTable(ctx.params.id);
  const partition = requirePartition(table.id, ctx.params.partition);
  const file = ctx.query.path;
  if (!file) throw badRequest('缺少 path 参数');
  const buf = readPage(partition.name, file);
  if (buf === null) throw notFound('文件不存在');
  const rows = buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 50)
    .map((l) => JSON.parse(l));
  return { status: 200, body: { path: file, rows, truncated: rows.length === 50 } };
});

route('GET', '/api/tables/:id/partitions/:partition/versions/:versionId/files/*filePath', (ctx) => {
  const table = requireTable(ctx.params.id);
  const partition = requirePartition(table.id, ctx.params.partition);
  const version = getVersion(ctx.params.versionId);
  if (!version || version.tableId !== table.id) throw notFound('版本不存在');
  const wanted = ctx.params.filePath;
  const entry = version.manifest.find((f) => f.partition === partition.name && f.path === wanted);
  if (!entry) throw notFound('该版本中不存在此文件');
  const buf = readObject(entry.checksum);
  const rows = buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 100)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { _raw: l };
      }
    });
  return { status: 200, body: { path: entry.path, checksum: entry.checksum, rows, truncated: rows.length >= 100 } };
});

/* ---- writes ---- */

route('POST', '/api/tables/:id/commit', async (ctx) => {
  const body = await readBody(ctx.req);
  const table = requireTable(ctx.params.id);
  const actor = actorFrom(ctx.req, body);
  if (!actor) throw badRequest('必须提供操作者（operator 或 X-Operator 头）以记录审计');
  const result = commitFiles({
    tableId: table.id,
    partition: requireString(body.partition, 'partition'),
    actor,
    message: body.message,
    reason: reasonOf(body, 2),
    files: body.files ?? [],
    deletePaths: body.deletePaths ?? [],
  });
  return { status: 201, body: result };
});

/* ---- diff & impact ---- */

route('POST', '/api/tables/:id/diff', async (ctx) => {
  const body = await readBody(ctx.req);
  const table = requireTable(ctx.params.id);
  const partition = requirePartition(table.id, body.partition);
  const target = resolveVersionOrThrow(table.id, body);
  const fromVersion = body.fromVersionId || body.fromSeq ? resolveVersionOrThrow(table.id, { versionId: body.fromVersionId, seq: body.fromSeq }) : null;
  const live = fromVersion ? null : buildManifest([partition]);
  const diff = diffPartition({ table, partition: partition.name, targetVersion: target, fromVersion, liveFiles: live });
  const impact = computeImpact({ table, partition: partition.name, diff });
  return { status: 200, body: { diff, impact, target: { id: target.id, seq: target.seq, label: target.label, createdAt: target.createdAt }, partition } };
});

route('GET', '/api/tables/:id/partitions/:partition/live', (ctx) => {
  const table = requireTable(ctx.params.id);
  const partition = requirePartition(table.id, ctx.params.partition);
  const manifest = buildManifest([partition]);
  return { status: 200, body: { partition, files: manifest, generatedAt: new Date().toISOString() } };
});

/* ---- restores ---- */

route('POST', '/api/restores', async (ctx) => {
  const body = await readBody(ctx.req);
  const job = createRestoreJob({
    ...body,
    operator: actorFrom(ctx.req, body),
    tableId: body.tableId ?? ctx.query.tableId,
  });
  return { status: 201, body: { job } };
});

route('GET', '/api/restores', (ctx) => {
  const jobs = listJobs({ tableId: ctx.query.tableId, partitionId: ctx.query.partitionId, limit: Number(ctx.query.limit ?? 50) });
  return { status: 200, body: { jobs } };
});

route('GET', '/api/restores/:id', (ctx) => {
  const job = getJob(ctx.params.id);
  if (!job) throw notFound('恢复任务不存在');
  return { status: 200, body: { job, files: listJobFiles(job.id) } };
});

route('GET', '/api/restores/:id/progress', (ctx) => ({ status: 200, body: jobProgress(ctx.params.id) }));

route('POST', '/api/restores/:id/conflict', async (ctx) => {
  const body = await readBody(ctx.req);
  const job = resolveConflict(ctx.params.id, {
    action: body.action,
    operator: actorFrom(ctx.req, body),
    reason: body.reason,
    ticket: body.ticket,
  });
  return { status: 200, body: { job } };
});

route('POST', '/api/restores/:id/cancel', async (ctx) => {
  const body = await readBody(ctx.req);
  const operator = actorFrom(ctx.req, body);
  if (!operator) throw badRequest('取消任务必须提供操作者');
  const job = cancelJob(ctx.params.id, { actor: operator, reason: reasonOf(body, 4) });
  return { status: 200, body: { job } };
});

route('POST', '/api/restores/:id/resume', async (ctx) => {
  const body = await readBody(ctx.req);
  const operator = actorFrom(ctx.req, body);
  if (!operator) throw badRequest('恢复执行必须提供操作者');
  const job = resumeJob(ctx.params.id, { actor: operator, reason: reasonOf(body, 4) });
  return { status: 200, body: { job } };
});

route('POST', '/api/restores/:id/rollback', async (ctx) => {
  const body = await readBody(ctx.req);
  const job = getJob(ctx.params.id);
  if (!job) throw notFound('恢复任务不存在');
  const operator = actorFrom(ctx.req, body);
  if (!operator) throw badRequest('回滚必须提供操作者');
  const report = rollbackApplied(job.id);
  recordEvent({
    actor: operator,
    action: 'restore.rollback_requested',
    entityType: 'restore_job',
    entityId: job.id,
    tableId: job.tableId,
    partitionId: job.partitionId,
    jobId: job.id,
    versionId: job.targetVersionId,
    reason: reasonOf(body, 4),
    snapshot: report,
  });
  return { status: 200, body: { rollback: report, job: getJob(job.id) } };
});

/* ---- audit ---- */

route('GET', '/api/audit', (ctx) => {
  const limit = Math.min(500, Math.max(1, Number(ctx.query.limit ?? 100)));
  const offset = Math.max(0, Number(ctx.query.offset ?? 0));
  const result = listEvents({
    tableId: ctx.query.tableId,
    partitionId: ctx.query.partitionId,
    jobId: ctx.query.jobId,
    entityType: ctx.query.entityType,
    entityId: ctx.query.entityId,
    limit,
    offset,
  });
  return { status: 200, body: result };
});

route('GET', '/api/audit/verify', (ctx) => ({ status: 200, body: verifyAuditChain({ tableId: ctx.query.tableId }) }));

/* ---- static ---- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    sendJson(res, 403, { error: { code: 'forbidden', message: '非法路径' } });
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      if (!path.extname(target)) return serveStatic(res, '/index.html');
      sendJson(res, 404, { error: { code: 'not_found', message: '文件不存在' } });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

function reasonOf(body, min = 4) {
  const reason = optionalString(body?.reason, 'reason', { max: 500 });
  if (!reason || reason.length < min) throw badRequest(`必须填写操作依据（reason，至少 ${min} 个字符）`);
  return reason;
}

function resolveVersionOrThrow(tableId, body) {
  const version = resolveVersionRef(tableId, body);
  if (!version) throw notFound('找不到目标版本');
  return version;
}

function resolveVersionRef(tableId, body) {
  if (body.versionId) return getVersion(body.versionId);
  if (body.seq !== undefined && body.seq !== null && body.seq !== '') return getVersionBySeq(tableId, Number(body.seq));
  if (body.at) return versionAt(tableId, new Date(body.at).toISOString());
  return latestVersion(tableId);
}

export function createServer() {
  getDb();
  setMeta('schema_version', '1');
  recoverInterruptedJobs();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      const found = match(req.method, pathname);
      if (!found) {
        sendError(res, new HttpError(404, 'not_found', `接口 ${req.method} ${pathname} 不存在`));
        return;
      }
      const ctx = { req, res, params: found.params, query: Object.fromEntries(url.searchParams) };
      try {
        const result = await found.handler(ctx);
        sendJson(res, result.status ?? 200, result.body ?? result);
      } catch (err) {
        sendError(res, err);
      }
      return;
    }
    serveStatic(res, pathname);
  });
}

export const serverPaths = { dbFile: getDbFile };
