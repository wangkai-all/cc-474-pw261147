import { CorruptionError, parseRows, readObject, readPage } from './storage.js';

const MAX_ROW_SAMPLES_PER_FILE = 25;
const MAX_ROW_SAMPLES_TOTAL = 250;

export function rowKeyOf(table, row) {
  const key = table.partitionKey || 'id';
  const value = row?.[key];
  return value === undefined || value === null ? null : String(value);
}

function parseRowsSafe(buf, label) {
  try {
    return parseRows(buf);
  } catch {
    throw new CorruptionError(`文件 ${label} 内容无法解析`);
  }
}

/**
 * Compare the target version's manifest for one partition with either the
 * current live files (default) or a second version's manifest.
 */
export function diffPartition({
  table,
  partition,
  targetVersion,
  fromVersion = null,
  liveFiles = null,
  readObjectBytes = readObject,
}) {
  const targetFiles = targetVersion.manifest.filter((f) => f.partition === partition);
  const baseFiles = fromVersion
    ? fromVersion.manifest.filter((f) => f.partition === partition)
    : (liveFiles ?? []);

  const targetByPath = new Map(targetFiles.map((f) => [f.path, f]));
  const baseByPath = new Map(baseFiles.map((f) => [f.path, f]));
  const allPaths = [...new Set([...targetByPath.keys(), ...baseByPath.keys()])].sort();

  const files = [];
  const samples = [];
  let sampleTruncated = false;
  const counts = { added: 0, modified: 0, removed: 0, unchanged: 0 };
  const rowTotals = { rowsAdded: 0, rowsRemoved: 0, rowsChanged: 0 };
  const damagedFiles = [];

  for (const rel of allPaths) {
    const target = targetByPath.get(rel) ?? null;
    const base = baseByPath.get(rel) ?? null;
    let change;
    if (target && !base) change = 'added';
    else if (!target && base) change = 'removed';
    else if (target && base && target.checksum !== base.checksum) change = 'modified';
    else change = 'unchanged';
    counts[change] += 1;

    const entry = {
      path: rel,
      change,
      baseline: base ? { checksum: base.checksum, bytes: base.bytes, rows: base.rows ?? null } : null,
      target: target ? { checksum: target.checksum, bytes: target.bytes, rows: target.rows ?? null } : null,
      rowsDelta: (target?.rows ?? 0) - (base?.rows ?? 0),
      bytesDelta: (target?.bytes ?? 0) - (base?.bytes ?? 0),
      rowDiff: null,
    };

    if (change === 'modified' || change === 'added' || change === 'removed') {
      let rowDiff;
      try {
        rowDiff = compareRowsForFile({
        rel,
        table,
        target,
        base,
        fromVersion,
        readTarget: () => parseRowsSafe(readObjectBytes(target.checksum), rel),
        readBase: () => {
          if (base.checksum && fromVersion) return parseRowsSafe(readObjectBytes(base.checksum), rel);
          const buf = readPage(partition, base.path);
          if (buf === null) throw new CorruptionError(`文件 ${rel} 在活动分区中已不存在`);
          return parseRowsSafe(buf, rel);
        },
        });
      } catch (err) {
        if (!(err instanceof CorruptionError)) throw err;
        entry.damaged = err.message;
        entry.rowDiff = { added: 0, removed: 0, changed: 0, identical: false, truncated: false, unavailable: true };
        files.push(entry);
        damagedFiles.push({ path: rel, reason: err.message });
        continue;
      }
      entry.rowDiff = {
        added: rowDiff.added.length,
        removed: rowDiff.removed.length,
        changed: rowDiff.changed.length,
        identical: rowDiff.identical,
        truncated: rowDiff.truncated,
      };
      rowTotals.rowsAdded += rowDiff.added.length;
      rowTotals.rowsRemoved += rowDiff.removed.length;
      rowTotals.rowsChanged += rowDiff.changed.length;

      for (const sample of [...rowDiff.added, ...rowDiff.removed, ...rowDiff.changed]) {
        if (samples.length >= MAX_ROW_SAMPLES_TOTAL) {
          sampleTruncated = true;
          break;
        }
        samples.push({ path: rel, ...sample });
      }
    }
    files.push(entry);
  }

  return {
    partition,
    targetVersion: versionRef(targetVersion),
    baseline: fromVersion ? versionRef(fromVersion) : { kind: 'live' },
    summary: {
      files: files.length,
      added: counts.added,
      modified: counts.modified,
      removed: counts.removed,
      unchanged: counts.unchanged,
      rowsAdded: rowTotals.rowsAdded,
      rowsRemoved: rowTotals.rowsRemoved,
      rowsChanged: rowTotals.rowsChanged,
      rowsDelta: rowTotals.rowsAdded - rowTotals.rowsRemoved,
      bytesDelta:
        files.reduce((sum, f) => sum + (f.target?.bytes ?? 0), 0) - files.reduce((sum, f) => sum + (f.baseline?.bytes ?? 0), 0),
      changedFiles: counts.added + counts.modified + counts.removed,
    },
    files,
    damagedFiles,
    damagedFileCount: damagedFiles.length,
    rows: samples,
    rowsTruncated: sampleTruncated,
    generatedAt: new Date().toISOString(),
  };
}

function versionRef(v) {
  return { id: v.id, seq: v.seq, label: v.label, createdAt: v.createdAt, author: v.author, kind: v.kind };
}

function compareRowsForFile({ rel, table, target, base, fromVersion, readTarget, readBase }) {
  if (!rel.endsWith('.ndjson')) {
    return { added: [], removed: [], changed: [], identical: false, truncated: false };
  }
  const targetRows = target ? readTarget() : [];
  const baseRows = base ? readBase() : [];
  const keyField = table.partitionKey || 'id';

  if (!targetRows.some((r) => r && typeof r === 'object' && keyField in r) && targetRows.length > 0) {
    // no usable key: fall back to whole-file change marker
    return { added: targetRows.slice(0, MAX_ROW_SAMPLES_PER_FILE), removed: [], changed: [], identical: false, truncated: targetRows.length > MAX_ROW_SAMPLES_PER_FILE };
  }

  const targetMap = new Map();
  for (const row of targetRows) {
    const key = rowKeyOf(table, row);
    if (key !== null) targetMap.set(key, row);
  }
  const baseMap = new Map();
  for (const row of baseRows) {
    const key = rowKeyOf(table, row);
    if (key !== null) baseMap.set(key, row);
  }

  const added = [];
  const removed = [];
  const changed = [];
  let identical = true;

  for (const [key, row] of targetMap) {
    if (!baseMap.has(key)) {
      comparedPush(added, { key, kind: 'added', after: row });
      identical = false;
    } else {
      const before = baseMap.get(key);
      const fields = changedFields(before, row);
      if (fields.length) {
        identical = false;
        comparedPush(changed, { key, kind: 'changed', changedFields: fields, before, after: row });
      }
      baseMap.delete(key);
    }
  }
  for (const [key, row] of baseMap) {
    comparedPush(removed, { key, kind: 'removed', before: row });
    identical = false;
  }

  return {
    added,
    removed,
    changed,
    identical,
    truncated: added.length + removed.length + changed.length > MAX_ROW_SAMPLES_PER_FILE,
  };
}

function comparedPush(list, item) {
  if (list.length >= MAX_ROW_SAMPLES_PER_FILE) return;
  list.push(item);
}

function changedFields(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const fields = [];
  for (const k of keys) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) fields.push(k);
  }
  return fields.sort();
}

/* ------------------------------------------------------------------ */
/* Downstream impact                                                   */
/* ------------------------------------------------------------------ */

/**
 * Estimate which downstream consumers observe the restored partition.
 * A consumer lists partition patterns (`*` or exact names) and columns it
 * reads; matching changed columns escalates severity.
 */
export function computeImpact({ table, partition, diff }) {
  const changedPaths = diff.files.filter((f) => f.change !== 'unchanged').map((f) => f.path);
  const changedRows = diff.summary.rowsAdded + diff.summary.rowsRemoved + diff.summary.rowsChanged;
  const matched = [];

  for (const asset of table.downstream ?? []) {
    const partitions = asset.partitions ?? ['*'];
    const partitionMatch = partitions.some((p) => p === '*' || p === partition);
    if (!partitionMatch) continue;
    const columns = asset.columns ?? [];
    const severity = asset.criticality === 'critical' ? 'high' : asset.criticality === 'high' ? 'medium' : asset.criticality === 'low' ? 'low' : 'medium';
    matched.push({
      id: asset.id ?? asset.name,
      name: asset.name,
      type: asset.type ?? 'consumer',
      owner: asset.owner ?? '',
      criticality: asset.criticality ?? 'medium',
      slaMinutes: asset.slaMinutes ?? null,
      schedule: asset.schedule ?? '',
      dependsOnPartitions: partitions,
      dependsOnColumns: columns,
      matchedPartitions: [partition],
      changedFiles: changedPaths.length,
      changedRows,
      severity,
      action:
        severity === 'high'
          ? '恢复后需通知值班人并重跑下游任务，必要时冻结依赖该分区的看板'
          : '恢复完成后触发下游增量回填，并核对数据新鲜度',
      note:
        columns.length > 0
          ? `依赖字段: ${columns.join(', ')}；恢复会覆盖这些字段的历史取值`
          : '未声明字段级依赖，按分区整体影响评估',
    });
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  matched.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.name.localeCompare(b.name));

  return {
    partition,
    partitionAffected: changedPaths.length > 0,
    changedFiles: changedPaths.length,
    changedRows,
    downstreamCount: matched.length,
    highSeverityCount: matched.filter((m) => m.severity === 'high').length,
    downstream: matched,
    generatedAt: new Date().toISOString(),
  };
}
