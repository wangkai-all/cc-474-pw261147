import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getBaseDir,
  getObjectsDir,
  getPagesDir,
  getStagingDir,
} from './paths.js';
import { HttpError } from './util.js';

export class CorruptionError extends Error {
  constructor(message) {
    super(message);
    this.code = 'corrupt';
  }
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeSegment(segment) {
  const cleaned = String(segment).replace(/[^a-zA-Z0-9._=-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

/** Resolve a partition-relative path, refusing traversal. */
export function resolvePagePath(partitionName, relPath) {
  const root = path.join(getPagesDir(), safeSegment(partitionName));
  const target = path.resolve(root, relPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new HttpError(400, 'bad_path', `非法文件路径: ${relPath}`);
  }
  return target;
}

export function objectPath(checksum) {
  return path.join(getObjectsDir(), checksum.slice(0, 2), checksum);
}

export function writeObject(buf) {
  const checksum = sha256(buf);
  const target = objectPath(checksum);
  if (!fs.existsSync(target)) {
    ensureDir(path.dirname(target));
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
  }
  return { checksum, bytes: buf.length };
}

/**
 * Read an immutable version object and verify its content hash.
 * A missing or altered object is reported as corruption (not a 404),
 * because the version manifest promises this exact content forever.
 */
export function readObject(checksum) {
  const target = objectPath(checksum);
  let buf;
  try {
    buf = fs.readFileSync(target);
  } catch {
    throw new CorruptionError(`对象 ${checksum.slice(0, 12)} 缺失`);
  }
  const actual = sha256(buf);
  if (actual !== checksum) {
    throw new CorruptionError(
      `对象 ${checksum.slice(0, 12)} 校验失败（期望 ${checksum.slice(0, 12)}，实际 ${actual.slice(0, 12)}）`,
    );
  }
  return buf;
}

export function objectExists(checksum) {
  return fs.existsSync(objectPath(checksum));
}

export function pagePathFor(partitionName, relPath) {
  return resolvePagePath(partitionName, relPath);
}

export function readPage(partitionName, relPath) {
  try {
    return fs.readFileSync(resolvePagePath(partitionName, relPath));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function statPage(partitionName, relPath) {
  try {
    const st = fs.statSync(resolvePagePath(partitionName, relPath));
    return { exists: true, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, bytes: 0, mtimeMs: 0 };
  }
}

export function inspectPage(partitionName, relPath) {
  try {
    const st = fs.statSync(resolvePagePath(partitionName, relPath));
    const buf = fs.readFileSync(resolvePagePath(partitionName, relPath));
    return {
      exists: true,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      checksum: sha256(buf),
    };
  } catch {
    return { exists: false, bytes: 0, mtimeMs: 0, checksum: null };
  }
}

export function writePageAtomic(partitionName, relPath, buf) {
  const target = resolvePagePath(partitionName, relPath);
  ensureDir(path.dirname(target));
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, buf);
  let fd;
  try {
    fd = fs.openSync(tmp, 'r');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  return { checksum: sha256(buf), bytes: buf.length };
}

export function removePage(partitionName, relPath) {
  try {
    fs.unlinkSync(resolvePagePath(partitionName, relPath));
    return true;
  } catch {
    return false;
  }
}

export function listPartitionFiles(partitionName) {
  const dir = path.join(getPagesDir(), safeSegment(partitionName));
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && !entry.name.includes('.tmp-')) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

export function backupPath(jobId, partitionName, relPath) {
  const root = path.join(getStagingDir(), safeSegment(jobId), safeSegment(partitionName));
  const target = path.resolve(root, relPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new HttpError(400, 'bad_path', `非法备份路径: ${relPath}`);
  }
  return target;
}

export function writeBackup(jobId, partitionName, relPath, buf) {
  const target = backupPath(jobId, partitionName, relPath);
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, buf);
  return { checksum: sha256(buf), bytes: buf.length };
}

export function readBackup(jobId, partitionName, relPath) {
  try {
    return fs.readFileSync(backupPath(jobId, partitionName, relPath));
  } catch {
    return null;
  }
}

export function removeBackup(jobId, partitionName, relPath) {
  try {
    fs.unlinkSync(backupPath(jobId, partitionName, relPath));
    return true;
  } catch {
    return false;
  }
}

export function clearStaging(jobId) {
  try {
    fs.rmSync(path.join(getStagingDir(), safeSegment(jobId)), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function parseRows(buf) {
  const text = buf.toString('utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      throw new CorruptionError('文件内容不是合法的 NDJSON');
    }
  }
  return rows;
}

export function serializeRows(rows) {
  if (!rows.length) return '';
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

export function sanitizeFileName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9._=-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120);
}

export function relativeToBase(p) {
  return path.relative(getBaseDir(), p);
}
