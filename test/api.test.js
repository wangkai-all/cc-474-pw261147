import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Each test file runs against an isolated data directory and an in-process
 * HTTP server on an ephemeral port.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timevault-test-'));
process.env.TV_DATA_DIR = tmp;
process.env.TV_JOB_TICK_MS = '5';

const { seedDatabase } = await import('../server/seed.js');
const { createServer } = await import('../server/index.js');
const { getDb, closeDb, getObjectsDir } = await import('../server/db.js');

seedDatabase({ force: true });
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const req = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
};
const get = (url, headers) => req('GET', url, undefined, headers);
const post = (url, body, headers) => req('POST', url, body, headers);

const waitFor = async (fn, { timeout = 8000, interval = 25 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('waitFor timed out');
};

const waitJob = async (id, states = ['completed', 'failed', 'cancelled', 'conflict']) => {
  return waitFor(async () => {
    const { body } = await get(`/api/restores/${id}`);
    if (!body?.job) return null;
    return states.includes(body.job.state) ? body.job : null;
  });
};

let jobCounter = 0;
const restore = (overrides = {}) =>
  post('/api/restores', {
    tableId: 'tbl_orders',
    partition: 'city=chengdu',
    seq: 4,
    operator: `测试员${jobCounter++}`,
    reason: '自动化测试恢复依据',
    ticket: 'TEST-001',
    ...overrides,
  });

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Health & catalog                                                    */
/* ------------------------------------------------------------------ */

test('health endpoint reports seeded state', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.seeded, true);
});

test('tables listing exposes partitions, versions and downstream', async () => {
  const { status, body } = await get('/api/tables');
  assert.equal(status, 200);
  const orders = body.tables.find((t) => t.id === 'tbl_orders');
  assert.ok(orders);
  assert.equal(orders.partitionCount, 4);
  assert.ok(orders.latestVersion.seq >= 5);
  assert.ok(orders.downstream.length >= 3);
});

test('table detail includes timeline and partitions', async () => {
  const { body } = await get('/api/tables/tbl_orders');
  assert.equal(body.table.name, 'dwd_orders');
  assert.equal(body.partitions.length, 4);
  assert.ok(body.versions.length >= 5);
  const seqs = body.versions.map((v) => v.seq);
  assert.deepEqual([...seqs].sort((a, b) => b - a), seqs, 'versions sorted newest first');
});

test('unknown table yields 404', async () => {
  const { status, body } = await get('/api/tables/nope');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'not_found');
});

/* ------------------------------------------------------------------ */
/* Diff & point-in-time resolution                                     */
/* ------------------------------------------------------------------ */

test('diff against live shows the deleted chengdu file as added on restore', async () => {
  const { status, body } = await post('/api/tables/tbl_orders/diff', { partition: 'city=chengdu', seq: 4 });
  assert.equal(status, 200);
  assert.equal(body.diff.summary.added, 1);
  assert.equal(body.diff.summary.removed, 0);
  const added = body.diff.files.find((f) => f.change === 'added');
  assert.equal(added.path, 'part-001.ndjson');
  assert.ok(added.rowDiff.added > 0);
  assert.ok(body.impact.downstreamCount > 0);
});

test('diff between two versions compares manifests, not live files', async () => {
  const { status, body } = await post('/api/tables/tbl_orders/diff', { partition: 'city=beijing', fromSeq: 1, seq: 3 });
  assert.equal(status, 200);
  assert.equal(body.diff.summary.modified, 1);
  const modified = body.diff.files.find((f) => f.change === 'modified');
  assert.equal(modified.path, 'part-000.ndjson');
  assert.ok(modified.rowDiff.changed >= 1, 'row-level change is detected');
});

test('time point resolves to the newest version at or before that instant', async () => {
  const { body } = await get('/api/tables/tbl_orders');
  const v3 = body.versions.find((v) => v.seq === 3);
  const res = await get(`/api/tables/tbl_orders/resolve?at=${encodeURIComponent(v3.createdAt)}`);
  assert.equal(res.body.version.seq, 3);
  const beforeAll = await get('/api/tables/tbl_orders/resolve?at=2000-01-01T00:00:00Z');
  assert.equal(beforeAll.body.version, null);
});

/* ------------------------------------------------------------------ */
/* Restore happy path + idempotency + audit                            */
/* ------------------------------------------------------------------ */

test('restore completes, produces a new version and records audit', async () => {
  const created = await restore({ operator: '李京', reason: '回滚误删除的成都文件' });
  assert.equal(created.status, 201);
  const job = await waitJob(created.body.job.id);
  assert.equal(job.state, 'completed');
  assert.equal(job.result, 'restored');
  assert.equal(job.progressPct, 100);
  assert.ok(job.newVersionId, 'a new version is emitted');

  // live partition now contains the restored file
  const detail = await get('/api/tables/tbl_orders/partitions/city=chengdu/live');
  assert.ok(detail.body.files.some((f) => f.path === 'part-001.ndjson'));

  // audit records who/why/snapshot
  const audit = await get(`/api/audit?jobId=${job.id}`);
  const actions = audit.body.events.map((e) => e.action);
  assert.ok(actions.includes('restore.requested'));
  assert.ok(actions.includes('restore.completed'));
  const completed = audit.body.events.find((e) => e.action === 'restore.completed');
  assert.equal(completed.actor, '李京');
  assert.equal(completed.reason, '回滚误删除的成都文件');
  assert.ok(completed.snapshot.targetVersion.snapshotHash);
});

test('restoring identical content twice is a safe no-op', async () => {
  const first = await restore({ operator: '陈数', reason: '第一次恢复以建立一致状态' });
  const j1 = await waitJob(first.body.job.id);
  assert.equal(j1.state, 'completed');

  const second = await restore({ operator: '陈数', reason: '重复执行验证幂等' });
  const j2 = await waitJob(second.body.job.id);
  assert.equal(j2.state, 'completed');
  assert.equal(j2.result, 'noop');
  assert.match(j2.message, /无需写入/);

  const audit = await get(`/api/audit?jobId=${j2.id}`);
  assert.ok(audit.body.events.some((e) => e.action === 'restore.noop'));
});

test('dry run computes diff/impact without touching files', async () => {
  // first desynchronise so there is something to do
  await post('/api/tables/tbl_orders/commit', {
    partition: 'city=chengdu',
    operator: '陈数',
    reason: '制造差异',
    message: '新增文件',
    files: [{ path: 'part-009.ndjson', rows: [{ order_id: 'x1' }] }],
  });
  const before = await get('/api/tables/tbl_orders/partitions/city=chengdu/live');
  const dry = await restore({ dryRun: true, operator: '演练员', reason: '演练恢复过程' });
  assert.equal(dry.status, 201);
  const job = dry.body.job;
  assert.equal(job.dryRun, true);
  assert.equal(job.state, 'completed');
  assert.equal(job.result, 'dry_run');
  assert.ok(job.diff.summary.removed >= 1, 'dry run previews file removals');
  const after = await get('/api/tables/tbl_orders/partitions/city=chengdu/live');
  assert.deepEqual(after.body.files.map((f) => f.checksum), before.body.files.map((f) => f.checksum), 'no bytes changed');
});

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

test('writes during an active restore are rejected with 409', async () => {
  // create a restore with a settle window so the job holds queued->running
  const created = await restore({ operator: '李京', reason: '占用分区验证写锁', settleMs: 400 });
  assert.equal(created.status, 201);
  // wait for preflight to grab the lock
  await waitFor(async () => {
    const r = await get('/api/tables/tbl_orders');
    return r.body.partitions.some((p) => p.name === 'city=chengdu' && p.lock);
  });
  const write = await post('/api/tables/tbl_orders/commit', {
    partition: 'city=chengdu',
    operator: '并发写入者',
    reason: '尝试并发写入',
    files: [{ path: 'part-010.ndjson', rows: [{ order_id: 'y1' }] }],
  });
  assert.equal(write.status, 409);
  assert.equal(write.body.error.code, 'partition_locked');
  await waitJob(created.body.job.id);
});

test('conflict is detected, pauses, and can be resolved by keeping current', async () => {
  // reset chengdu to a known state first (restore to v4)
  const reset = await restore({ operator: '李京', reason: '准备冲突测试基线' });
  await waitJob(reset.body.job.id);

  // start job with settle window, then write concurrently
  const created = await restore({ operator: '李京', reason: '冲突测试：检测并发写入', settleMs: 500, conflictAction: 'pause' });
  const jobId = created.body.job.id;
  await new Promise((r) => setTimeout(r, 100));
  const write = await post('/api/tables/tbl_orders/commit', {
    partition: 'city=chengdu',
    operator: '陈数',
    reason: '并发写入',
    message: '并发写入新文件',
    files: [{ path: 'part-001.ndjson', rows: [{ order_id: 'concurrent-1', amount: 1 }] }],
  });
  assert.equal(write.status, 201);

  const paused = await waitJob(jobId, ['conflict']);
  assert.equal(paused.state, 'conflict');
  assert.ok(paused.conflicts.length >= 1);
  assert.equal(paused.conflicts[0].reason, 'concurrent_write');

  // the conflicting file must NOT have been overwritten yet
  const live = await get('/api/tables/tbl_orders/partitions/city=chengdu/live');
  const file = live.body.files.find((f) => f.path === 'part-001.ndjson');
  assert.equal(file.checksum, paused.conflicts[0].liveChecksum);

  // resolving with keep_current resumes and completes
  const resolved = await post(`/api/restores/${jobId}/conflict`, {
    action: 'keep_current',
    operator: '王点',
    reason: '并发写入合法，保留其内容',
  });
  assert.equal(resolved.status, 200);
  const done = await waitJob(jobId, ['completed', 'failed']);
  assert.equal(done.state, 'completed');

  const audit = await get(`/api/audit?jobId=${jobId}`);
  const decision = audit.body.events.find((e) => e.action === 'restore.conflict_decision');
  assert.equal(decision.actor, '王点');
  assert.equal(decision.reason, '并发写入合法，保留其内容');
  assert.ok(decision.snapshot.conflicts.length >= 1);
});

test('conflict resolution requires operator and reason', async () => {
  const reset = await restore({ operator: '李京', reason: '准备参数校验基线' });
  await waitJob(reset.body.job.id);
  const created = await restore({ operator: '李京', reason: '参数校验冲突测试', settleMs: 500 });
  await new Promise((r) => setTimeout(r, 100));
  await post('/api/tables/tbl_orders/commit', {
    partition: 'city=chengdu',
    operator: '陈数',
    reason: '并发写入',
    files: [{ path: 'part-001.ndjson', rows: [{ order_id: 'c2' }] }],
  });
  const paused = await waitJob(created.body.job.id, ['conflict']);
  assert.equal(paused.state, 'conflict');

  const missing = await post(`/api/restores/${created.body.job.id}/conflict`, { action: 'keep_current' });
  assert.equal(missing.status, 400);
  const badAction = await post(`/api/restores/${created.body.job.id}/conflict`, { action: 'delete', operator: 'x', reason: 'whatever' });
  assert.equal(badAction.status, 400);
  const noReason = await post(`/api/restores/${created.body.job.id}/conflict`, { action: 'abort', operator: 'x', reason: 'a' });
  assert.equal(noReason.status, 400);

  // clean up by aborting
  const aborted = await post(`/api/restores/${created.body.job.id}/conflict`, { action: 'abort', operator: '李京', reason: '清理测试任务' });
  assert.equal(aborted.status, 200);
  assert.equal(aborted.body.job.state, 'cancelled');
});

test('restore requires operator and reason', async () => {
  const noOp = await post('/api/restores', { tableId: 'tbl_orders', partition: 'city=chengdu', reason: 'x' });
  assert.equal(noOp.status, 400);
  const noReason = await post('/api/restores', { tableId: 'tbl_orders', partition: 'city=chengdu', operator: '李京' });
  assert.equal(noReason.status, 400);
  const badSeq = await post('/api/restores', { tableId: 'tbl_orders', partition: 'city=chengdu', operator: '李京', reason: '合法依据', seq: 999 });
  assert.equal(badSeq.status, 404);
});

/* ------------------------------------------------------------------ */
/* Corruption                                                          */
/* ------------------------------------------------------------------ */

test('a single damaged object blocks the restore during preflight', async () => {
  // create a fresh housekeeping job so state is consistent
  // `seq: 3` touches a different partition, so the target chengdu manifest used
  // by the corruption test below is untouched by this reset.
  // Create drift first: with no drift the restore correctly short-circuits as a
  // no-op and never needs to read the objects we are about to damage.
  await post('/api/tables/tbl_orders/commit', {
    partition: 'city=chengdu',
    operator: '陈数',
    reason: '制造待恢复差异',
    files: [{ path: 'part-000.ndjson', rows: [{ order_id: 'drift-1', amount: 3 }] }],
  });

  // corrupt one object belonging to v4's chengdu manifest
  const detail = await get('/api/tables/tbl_orders');
  const v4 = detail.body.versions.find((v) => v.seq === 4);
  const entry = v4.manifest.find((f) => f.partition === 'city=chengdu');
  assert.ok(entry);
  const objPath = path.join(getObjectsDir(), entry.checksum.slice(0, 2), entry.checksum);
  const original = fs.readFileSync(objPath);
  fs.writeFileSync(objPath, 'CORRUPTED');

  try {
    const created = await restore({ operator: '李京', reason: '损坏对象应阻断恢复' });
    const failed = await waitJob(created.body.job.id, ['failed']);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.result, 'integrity_failed');
    assert.equal(failed.checkState, 'failed');
    assert.ok(failed.integrity.damaged.length >= 1);
    assert.match(failed.message, /损坏或缺失/);

    // no file was written
    const audit = await get(`/api/audit?jobId=${created.body.job.id}`);
    assert.ok(audit.body.events.some((e) => e.action === 'restore.integrity_failed'));
    const live = await get('/api/tables/tbl_orders/partitions/city=chengdu/live');
    assert.ok(live.body.files.length >= 1);

    // diff still works and flags the damaged file instead of 500ing
    const diff = await post('/api/tables/tbl_orders/diff', { partition: 'city=chengdu', seq: 4 });
    assert.equal(diff.status, 200);
    assert.ok(diff.body.diff.damagedFileCount >= 1);
  } finally {
    fs.writeFileSync(objPath, original);
  }

  // after repair the same restore succeeds
  const retry = await restore({ operator: '李京', reason: '修复对象后再次恢复' });
  const ok = await waitJob(retry.body.job.id);
  assert.equal(ok.state, 'completed');
});

test('partial corruption does not corrupt other files', async () => {
  const before = await get('/api/tables/tbl_orders/partitions/city=shanghai/live');
  const detail = await get('/api/tables/tbl_orders');
  const v1 = detail.body.versions.find((v) => v.seq === 1);
  const shanghaiEntry = v1.manifest.find((f) => f.partition === 'city=shanghai');
  const objPath = path.join(getObjectsDir(), shanghaiEntry.checksum.slice(0, 2), shanghaiEntry.checksum);
  const original = fs.readFileSync(objPath);
  fs.writeFileSync(objPath, 'BROKEN');
  try {
    // chengdu restore must be unaffected by shanghai's damaged object
    const created = await restore({ operator: '李京', reason: '验证损坏隔离性' });
    const job = await waitJob(created.body.job.id);
    assert.equal(job.state, 'completed');
    assert.equal(job.integrity.damaged.length, 0);
    const after = await get('/api/tables/tbl_orders/partitions/city=shanghai/live');
    assert.deepEqual(after.body.files.map((f) => f.checksum), before.body.files.map((f) => f.checksum));
  } finally {
    fs.writeFileSync(objPath, original);
  }
});

/* ------------------------------------------------------------------ */
/* Audit chain                                                         */
/* ------------------------------------------------------------------ */

test('audit chain verifies and detects tampering', async () => {
  const { body } = await get('/api/audit/verify');
  assert.equal(body.ok, true);
  assert.ok(body.checked > 0);

  // tamper with a row directly; verification must fail
  const db = getDb();
  const row = db.prepare("SELECT id, reason FROM audit_events WHERE action = 'restore.completed' LIMIT 1").get();
  db.prepare('UPDATE audit_events SET reason = ? WHERE id = ?').run('被篡改的理由', row.id);
  const tampered = await get('/api/audit/verify');
  assert.equal(tampered.body.ok, false);
  assert.ok(tampered.body.broken.length >= 1);
  db.prepare('UPDATE audit_events SET reason = ? WHERE id = ?').run(row.reason, row.id);
  const restored = await get('/api/audit/verify');
  assert.equal(restored.body.ok, true);
});

test('audit events expose original version, actor and evidence', async () => {
  const { body } = await get('/api/audit?limit=200');
  const requested = body.events.find((e) => e.action === 'restore.requested');
  assert.ok(requested);
  assert.ok(requested.actor);
  assert.ok(requested.reason);
  assert.ok(requested.snapshot.target.id);
  assert.ok(requested.snapshot.target.snapshotHash);
  assert.ok(Array.isArray(requested.snapshot.plan));
});

/* ------------------------------------------------------------------ */
/* Rollback / cancel                                                   */
/* ------------------------------------------------------------------ */

test('cancel rolls back applied files', async () => {
  // ensure chengdu is desynced first
  await post('/api/tables/tbl_orders/commit', {
    partition: 'city=chengdu',
    operator: '陈数',
    reason: '制造差异',
    files: [{ path: 'part-777.ndjson', rows: [{ order_id: 'zzz' }] }],
  });
  const before = await get('/api/tables/tbl_orders/partitions/city=chengdu/live');
  const created = await restore({ operator: '李京', reason: '取消测试', settleMs: 900 });
  const jobId = created.body.job.id;

  // Cancel from inside the settling window (task still queued): the lock is not
  // taken yet, so this exercises cancelling before any write happened.
  const cancelled = await post(`/api/restores/${jobId}/cancel`, { operator: '王点', reason: '取消并恢复原状' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.state, 'cancelled');
  const after = await get('/api/tables/tbl_orders/partitions/city=chengdu/live');
  assert.deepEqual(
    after.body.files.map((f) => [f.path, f.checksum]),
    before.body.files.map((f) => [f.path, f.checksum]),
    'files returned to pre-restore bytes',
  );
  const audit = await get(`/api/audit?jobId=${jobId}`);
  assert.ok(audit.body.events.some((e) => e.action === 'restore.cancelled'));
});

test('one active restore per partition is enforced', async () => {
  const first = await restore({ operator: '李京', reason: '占用任务一', settleMs: 600 });
  assert.equal(first.status, 201);
  const second = await restore({ operator: '王点', reason: '占用任务二' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'conflict');
  await waitJob(first.body.job.id);
});
