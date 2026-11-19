import { getDb, getMeta, setMeta } from './db.js';
import { newId, nowIso, parseJson, toJson, sha256Text } from './util.js';

let cachedLastHash = undefined;

function lastAuditHash() {
  if (cachedLastHash !== undefined) return cachedLastHash;
  const row = getDb().prepare('SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1').get();
  cachedLastHash = row?.hash ?? null;
  return cachedLastHash;
}

export function resetAuditCache() {
  cachedLastHash = undefined;
}

/**
 * Append an audit event. The table is append-only: rows keep the original
 * snapshot of what was changed, who did it and the stated justification.
 */
export function recordEvent({
  actor,
  action,
  entityType,
  entityId,
  tableId = null,
  partitionId = null,
  jobId = null,
  versionId = null,
  reason = null,
  evidence = null,
  snapshot = null,
  at = nowIso(),
}) {
  const prevHash = lastAuditHash();
  const snapshotJson = snapshot === null ? null : toJson(snapshot);
  const id = newId('evt_');
  const hash = sha256Text(
    [prevHash, at, actor, action, entityType, entityId, tableId, partitionId, jobId, versionId, reason, evidence, snapshotJson].join('\u0001'),
  );
  getDb()
    .prepare(
      `INSERT INTO audit_events (id, at, actor, action, entity_type, entity_id, table_id, partition_id, job_id, version_id, reason, evidence, snapshot_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, at, actor, action, entityType, entityId, tableId, partitionId, jobId, versionId, reason, evidence, snapshotJson, prevHash, hash);
  cachedLastHash = hash;
  return { id, hash, at };
}

export function listEvents({ tableId, partitionId, jobId, entityType, entityId, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (tableId) {
    where.push('table_id = ?');
    params.push(tableId);
  }
  if (partitionId) {
    where.push('partition_id = ?');
    params.push(partitionId);
  }
  if (jobId) {
    where.push('job_id = ?');
    params.push(jobId);
  }
  if (entityType) {
    where.push('entity_type = ?');
    params.push(entityType);
  }
  if (entityId) {
    where.push('entity_id = ?');
    params.push(entityId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM audit_events ${whereSql}`).get(...params).n;
  const rows = getDb()
    .prepare(`SELECT * FROM audit_events ${whereSql} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return {
    total,
    events: rows.map((row) => ({
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      tableId: row.table_id,
      partitionId: row.partition_id,
      jobId: row.job_id,
      versionId: row.version_id,
      reason: row.reason,
      evidence: parseJson(row.evidence),
      snapshot: parseJson(row.snapshot_json),
      prevHash: row.prev_hash,
      hash: row.hash,
    })),
  };
}

export function verifyAuditChain({ tableId = null } = {}) {
  const rows = tableId
    ? getDb().prepare('SELECT * FROM audit_events WHERE table_id = ? ORDER BY rowid ASC').all(tableId)
    : getDb().prepare('SELECT * FROM audit_events ORDER BY rowid ASC').all();
  let prev = tableId ? null : null;
  const broken = [];
  for (const row of rows) {
    const expected = sha256Text(
      [prev, row.at, row.actor, row.action, row.entity_type, row.entity_id, row.table_id, row.partition_id, row.job_id, row.version_id, row.reason, row.evidence, row.snapshot_json].join('\u0001'),
    );
    if (expected !== row.hash) {
      broken.push({ id: row.id, at: row.at, action: row.action, reason: '哈希自校验失败' });
    }
    if (prev !== null && row.prev_hash !== prev) {
      broken.push({ id: row.id, at: row.at, action: row.action, reason: '前序哈希不匹配' });
    }
    prev = row.hash;
  }
  return { ok: broken.length === 0, checked: rows.length, broken };
}

export function bumpGeneration() {
  const current = Number(getMeta('generation', '0'));
  setMeta('generation', String(current + 1));
  return current + 1;
}

export function generation() {
  return Number(getMeta('generation', '0'));
}
