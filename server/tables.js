import { getDb, tx } from './db.js';
import { HttpError, badRequest, newId, nowIso, notFound, optionalString, parseJson, requireString, sha256Text, stableStringify, toJson } from './util.js';
import { inspectPage, listPartitionFiles, parseRows, readPage, removePage, serializeRows, writeObject, writePageAtomic } from './storage.js';
import { recordEvent } from './audit.js';
import { activeRestoreForPartition } from './locks.js';

export function listTables() {
  return getDb().prepare('SELECT * FROM tables ORDER BY name ASC').all().map(shapeTable);
}

export function shapeTable(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    partitionKey: row.partition_key,
    columns: parseJson(row.columns_json, []),
    downstream: parseJson(row.downstream_json, []),
    owner: row.owner,
    createdAt: row.created_at,
  };
}

export function getTable(id) {
  const row = getDb().prepare('SELECT * FROM tables WHERE id = ?').get(id);
  return row ? shapeTable(row) : null;
}

export function requireTable(id) {
  const table = getTable(id);
  if (!table) throw notFound(`数据表 ${id} 不存在`);
  return table;
}

export function listPartitions(tableId) {
  return getDb().prepare('SELECT * FROM partitions WHERE table_id = ? ORDER BY name ASC').all(tableId).map(shapePartition);
}

export function shapePartition(r) {
  return {
    id: r.id,
    tableId: r.table_id,
    name: r.name,
    label: r.label,
    fileCount: r.file_count,
    rowCount: r.row_count,
    totalBytes: r.total_bytes,
    createdAt: r.created_at,
  };
}

export function getPartition(tableId, nameOrId) {
  const row = getDb()
    .prepare('SELECT * FROM partitions WHERE table_id = ? AND (name = ? OR id = ?)')
    .get(tableId, nameOrId, nameOrId);
  return row ?? null;
}

export function requirePartition(tableId, nameOrId) {
  const row = getPartition(tableId, nameOrId);
  if (!row) throw notFound(`分区 ${nameOrId} 不存在`);
  return shapePartition(row);
}

export function ensurePartition(tableId, name, label = '') {
  const existing = getPartition(tableId, name);
  if (existing) return shapePartition(existing);
  const id = newId('pt_');
  getDb()
    .prepare(
      'INSERT INTO partitions (id, table_id, name, label, file_count, row_count, total_bytes, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)',
    )
    .run(id, tableId, name, label, nowIso());
  return shapePartition(getPartition(tableId, name));
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

export function shapeVersion(r) {
  return {
    id: r.id,
    tableId: r.table_id,
    seq: r.seq,
    label: r.label,
    kind: r.kind,
    reason: r.reason,
    author: r.author,
    createdAt: r.created_at,
    pageCount: r.page_count,
    rowCount: r.row_count,
    totalBytes: r.total_bytes,
    snapshotHash: r.snapshot_hash,
    manifest: parseJson(r.manifest_json, []),
    baselineId: r.baseline_id,
    restoreJobId: r.restore_job_id,
    changes: parseJson(r.changes_json, []),
    damagedFiles: r.damaged_files,
  };
}

export function getVersion(id) {
  const row = getDb().prepare('SELECT * FROM versions WHERE id = ?').get(id);
  return row ? shapeVersion(row) : null;
}

export function getVersionBySeq(tableId, seq) {
  const row = getDb().prepare('SELECT * FROM versions WHERE table_id = ? AND seq = ?').get(tableId, seq);
  return row ? shapeVersion(row) : null;
}

export function latestVersion(tableId) {
  const row = getDb().prepare('SELECT * FROM versions WHERE table_id = ? ORDER BY seq DESC LIMIT 1').get(tableId);
  return row ? shapeVersion(row) : null;
}

export function versionAt(tableId, isoTime) {
  const row = getDb()
    .prepare('SELECT * FROM versions WHERE table_id = ? AND created_at <= ? ORDER BY seq DESC LIMIT 1')
    .get(tableId, isoTime);
  return row ? shapeVersion(row) : null;
}

export function listVersions(tableId, { limit = 200 } = {}) {
  return getDb()
    .prepare('SELECT * FROM versions WHERE table_id = ? ORDER BY seq DESC LIMIT ?')
    .all(tableId, limit)
    .map(shapeVersion);
}

export function manifestForPartition(version, partitionName) {
  return (version.manifest ?? []).filter((f) => f.partition === partitionName);
}

/**
 * Snapshot the live partition directories into an immutable manifest. Called
 * whenever a write or restore completes, so every version can be restored
 * byte-for-byte later even after the live files move on.
 */
export function buildManifest(partitions) {
  const files = [];
  for (const partition of partitions) {
    for (const rel of listPartitionFiles(partition.name)) {
      const page = inspectPage(partition.name, rel);
      if (!page.exists) continue;
      const buf = readPage(partition.name, rel) ?? Buffer.alloc(0);
      let rows = 0;
      let rowCountKnown = true;
      try {
        rows = parseRows(buf).length;
      } catch {
        rowCountKnown = false;
        rows = 0;
      }
      // Content-address every file so this version stays restorable even
      // after the live partition is rewritten or deleted.
      const object = writeObject(buf);
      files.push({ partition: partition.name, path: rel, checksum: object.checksum, bytes: object.bytes, rows, rowCountKnown });
    }
  }
  files.sort((a, b) => `${a.partition}/${a.path}`.localeCompare(`${b.partition}/${b.path}`));
  return files;
}

export function snapshotHashOf(manifest) {
  return sha256Text(stableStringify(manifest));
}

export function aggregatesOf(manifest) {
  return {
    pageCount: manifest.length,
    rowCount: manifest.reduce((sum, f) => sum + (f.rows || 0), 0),
    totalBytes: manifest.reduce((sum, f) => sum + (f.bytes || 0), 0),
  };
}

export function aggregatePartition(manifest, partitionName) {
  const files = manifest.filter((f) => f.partition === partitionName);
  return {
    fileCount: files.length,
    rowCount: files.reduce((sum, f) => sum + (f.rows || 0), 0),
    totalBytes: files.reduce((sum, f) => sum + (f.bytes || 0), 0),
  };
}

/**
 * Create a version from the current live state of all partitions.
 * Versions are append-only: restoring the same content again still produces a
 * new sequence number so the timeline records that a restore happened.
 */
export function createVersion({ tableId, kind, label, reason, author, changes = [], baselineId = null, restoreJobId = null, at = nowIso(), partitions }) {
  const conn = getDb();
  const partitionRows = partitions ?? listPartitions(tableId);
  const manifest = buildManifest(partitionRows);
  const { pageCount, rowCount, totalBytes } = aggregatesOf(manifest);
  const id = newId('v_');
  const seq = conn.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM versions WHERE table_id = ?').get(tableId).n;
  tx((db) => {
    db.prepare(
      `INSERT INTO versions (id, table_id, seq, label, kind, reason, author, created_at, page_count, row_count, total_bytes, snapshot_hash, manifest_json, baseline_id, restore_job_id, changes_json, damaged_files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, -1)`,
    ).run(
      id,
      tableId,
      seq,
      label ?? '',
      kind,
      reason ?? '',
      author,
      at,
      pageCount,
      rowCount,
      totalBytes,
      snapshotHashOf(manifest),
      toJson(manifest),
      baselineId,
      restoreJobId,
      toJson(changes),
    );
    for (const p of partitionRows) {
      const agg = aggregatePartition(manifest, p.name);
      db.prepare('UPDATE partitions SET file_count = ?, row_count = ?, total_bytes = ? WHERE id = ?').run(
        agg.fileCount,
        agg.rowCount,
        agg.totalBytes,
        p.id,
      );
    }
  });
  return getVersion(id);
}

/* ------------------------------------------------------------------ */
/* Commits (writes)                                                    */
/* ------------------------------------------------------------------ */

export function shapeCommit(r) {
  return {
    id: r.id,
    tableId: r.table_id,
    partitionId: r.partition_id,
    versionId: r.version_id,
    baseVersionId: r.base_version_id,
    kind: r.kind,
    rowCount: r.row_count,
    totalBytes: r.total_bytes,
    actor: r.actor,
    message: r.message,
    createdAt: r.created_at,
  };
}

export function listCommits(tableId, { limit = 100, partitionId = null } = {}) {
  const rows = partitionId
    ? getDb().prepare('SELECT * FROM commits WHERE table_id = ? AND partition_id = ? ORDER BY created_at DESC LIMIT ?').all(tableId, partitionId, limit)
    : getDb().prepare('SELECT * FROM commits WHERE table_id = ? ORDER BY created_at DESC LIMIT ?').all(tableId, limit);
  return rows.map(shapeCommit);
}

/**
 * Write files into a partition and pin a new version. An active restore job
 * holds the partition lock, so concurrent writes fail with 409 rather than
 * being silently overwritten by the restore.
 */
export function commitFiles({ tableId, partition, actor, message, reason, files = [], deletePaths = [] }) {
  requireTable(tableId);
  const partitionRow = requirePartition(tableId, partition);
  const lock = activeRestoreForPartition(partitionRow.id);
  if (lock) {
    throw new HttpError(409, 'partition_locked', '该分区正在执行恢复任务，写入已被保护性拒绝；请等待恢复完成、取消任务或先处理冲突', {
      partition: partitionRow.name,
      jobId: lock.id,
      jobState: lock.state,
    });
  }
  if (files.length === 0 && deletePaths.length === 0) throw badRequest('至少提供一个文件写入或删除路径');
  const baseVersion = latestVersion(tableId);
  const written = [];
  for (const file of files) {
    const rel = requireString(file?.path, 'files[].path', { max: 200 });
    if (rel.includes('..') || rel.startsWith('/')) throw badRequest(`非法文件路径: ${rel}`);
    if (!Array.isArray(file.rows)) throw badRequest(`文件 ${rel} 的 rows 必须是数组`);
    const buf = Buffer.from(serializeRows(file.rows), 'utf8');
    if (buf.length > 8 * 1024 * 1024) throw badRequest(`文件 ${rel} 超过 8 MiB 限制`);
    const result = writePageAtomic(partitionRow.name, rel, buf);
    written.push({ path: rel, checksum: result.checksum, bytes: result.bytes, rows: file.rows.length, action: 'write' });
  }
  for (const rel of deletePaths) {
    if (typeof rel !== 'string' || rel.includes('..')) throw badRequest(`非法文件路径: ${rel}`);
    removePage(partitionRow.name, rel);
    written.push({ path: rel, action: 'delete' });
  }
  const version = createVersion({
    tableId,
    kind: 'commit',
    label: optionalString(message, 'message', { max: 200 }) ?? '人工提交',
    reason: reason ?? '',
    author: actor,
    changes: [{ partition: partitionRow.name, files: written }],
    baselineId: baseVersion?.id ?? null,
  });
  getDb()
    .prepare(
      `INSERT INTO commits (id, table_id, partition_id, version_id, base_version_id, kind, row_count, total_bytes, actor, message, created_at)
       VALUES (?, ?, ?, ?, ?, 'commit', ?, ?, ?, ?, ?)`,
    )
    .run(newId('cm_'), tableId, partitionRow.id, version.id, baseVersion?.id ?? null, version.rowCount, version.totalBytes, actor, message ?? '', version.createdAt);
  recordEvent({
    actor,
    action: 'commit.created',
    entityType: 'version',
    entityId: version.id,
    tableId,
    partitionId: partitionRow.id,
    versionId: version.id,
    reason: reason ?? null,
    evidence: message ?? null,
    snapshot: { partition: partitionRow.name, files: written, baseVersionId: baseVersion?.id ?? null },
    at: version.createdAt,
  });
  return { version, files: written };
}

export function inspectPartitionLive(partitionName) {
  return listPartitionFiles(partitionName).map((rel) => {
    const page = inspectPage(partitionName, rel);
    let rows = null;
    try {
      rows = parseRows(readPage(partitionName, rel) ?? Buffer.alloc(0)).length;
    } catch {
      rows = null;
    }
    return { path: rel, checksum: page.checksum, bytes: page.bytes, rows };
  });
}
