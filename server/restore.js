import { getDb } from './db.js';
import { buildManifest, getPartition, getVersion, versionAt, latestVersion, createVersion, listPartitions, requireTable, requirePartition } from './tables.js';
import { diffPartition, computeImpact } from './diff.js';
import { CorruptionError, inspectPage, readObject, readPage as readLive, removePage, writePageAtomic, writeBackup, readBackup, clearStaging } from './storage.js';
import { HttpError, badRequest, conflict as conflictError, newId, nowIso, parseJson, toJson } from './util.js';
import { recordEvent } from './audit.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// `queued` deliberately does NOT lock: the restore has not touched any file
// yet, so writes are still safe. The lock is taken when work begins.
const LOCK_STATES = new Set(['checking', 'running', 'conflict', 'verifying', 'finalizing']);
const WORK_STATES = new Set(['running', 'checking', 'verifying', 'finalizing']);

const TICK_MS = Number(process.env.TV_JOB_TICK_MS ?? 120);

// Pace a restore so progress is observable without making large restores crawl.
function paceDelay(fileTotal) {
  return Math.max(10, Math.min(TICK_MS, Math.round(1500 / Math.max(1, fileTotal))));
}
const timers = new Map();

export const jobStates = { TERMINAL, LOCK_STATES };

export function getJob(id) {
  const row = getDb().prepare('SELECT * FROM restore_jobs WHERE id = ?').get(id);
  return row ? shapeJob(row) : null;
}

export function shapeJob(r) {
  return {
    id: r.id,
    tableId: r.table_id,
    partitionId: r.partition_id,
    targetVersionId: r.target_version_id,
    targetVersionSeq: r.target_version_seq,
    targetAt: r.target_at,
    targetLabel: r.target_label,
    mode: r.mode,
    state: r.state,
    phase: r.phase,
    result: r.result,
    checkState: r.check_state,
    conflictAction: r.conflict_action,
    fileSelection: r.file_selection,
    selectedPaths: parseJson(r.selected_paths_json, []),
    operator: r.operator,
    reason: r.reason,
    ticket: r.ticket,
    baselineVersionId: r.baseline_version_id,
    baselineSeq: r.baseline_seq,
    baselineAt: r.baseline_at,
    settleMs: r.settle_ms,
    dryRun: Boolean(r.dry_run),
    progressPct: r.progress_pct,
    totalBytes: r.total_bytes,
    processedBytes: r.processed_bytes,
    fileTotal: r.file_total,
    fileProcessed: r.file_processed,
    conflictCount: r.conflict_count,
    diff: parseJson(r.diff_json),
    impact: parseJson(r.impact_json),
    integrity: parseJson(r.check_json),
    conflicts: parseJson(r.conflict_json, []),
    error: parseJson(r.error_json),
    message: r.message,
    lastHeartbeat: r.last_heartbeat,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    newVersionId: r.new_version_id,
    reverted: Boolean(r.reverted),
    canResolve: r.state === 'conflict',
    canCancel: !TERMINAL.has(r.state),
    canResume: r.state === 'paused',
  };
}

export function listJobs({ tableId, partitionId, limit = 50 } = {}) {
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
  const sql = `SELECT * FROM restore_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  return getDb().prepare(sql).all(...params, limit).map(shapeJob);
}

export function listJobFiles(jobId) {
  return getDb()
    .prepare('SELECT * FROM job_files WHERE job_id = ? ORDER BY path ASC')
    .all(jobId)
    .map((r) => ({
      id: r.id,
      path: r.path,
      partition: r.partition_name,
      sourceKind: r.source_kind,
      sourceVersionId: r.source_version_id,
      sourceVersionSeq: r.source_version_seq,
      baselineChecksum: r.baseline_checksum,
      targetChecksum: r.target_checksum,
      baselineBytes: r.baseline_bytes,
      targetBytes: r.target_bytes,
      status: r.status,
      skipReason: r.skip_reason,
      conflictReason: r.conflict_reason,
      verifyState: r.verify_state,
      attempt: r.attempt,
      error: r.error,
      updatedAt: r.updated_at,
    }));
}

function setJob(id, patch) {
  const columns = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    columns.push(`${key} = ?`);
    values.push(value);
  }
  columns.push('updated_at = ?');
  values.push(nowIso());
  getDb().prepare(`UPDATE restore_jobs SET ${columns.join(', ')} WHERE id = ?`).run(...values, id);
}

/* ------------------------------------------------------------------ */
/* Target resolution                                                   */
/* ------------------------------------------------------------------ */

export function resolveTarget(tableId, { versionId, seq, at, label }) {
  if (versionId) {
    const version = getVersion(versionId);
    if (!version || version.tableId !== tableId) throw new HttpError(404, 'not_found', `版本 ${versionId} 不存在`);
    return version;
  }
  if (seq !== undefined && seq !== null && seq !== '') {
    const n = Number(seq);
    if (!Number.isInteger(n) || n < 1) throw badRequest('版本序号必须是正整数');
    const version = getDb().prepare('SELECT id FROM versions WHERE table_id = ? AND seq = ?').get(tableId, n);
    if (!version) throw new HttpError(404, 'not_found', `版本 #${n} 不存在`);
    return getVersion(version.id);
  }
  if (at) {
    const normalized = normalizeTime(at);
    const version = versionAt(tableId, normalized);
    if (!version) throw new HttpError(404, 'not_found', `时间点 ${at} 之前没有可用版本`);
    return version;
  }
  if (label) {
    const row = getDb().prepare('SELECT id FROM versions WHERE table_id = ? AND label = ? ORDER BY seq DESC LIMIT 1').get(tableId, label);
    if (!row) throw new HttpError(404, 'not_found', `找不到标签为 ${label} 的版本`);
    return getVersion(row.id);
  }
  const latest = latestVersion(tableId);
  if (!latest) throw badRequest('该数据表还没有任何版本，无法恢复');
  return latest;
}

function normalizeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`无法解析时间点: ${value}`);
  return date.toISOString();
}

/* ------------------------------------------------------------------ */
/* Job creation                                                        */
/* ------------------------------------------------------------------ */

export function createRestoreJob(body) {
  const table = requireTable(body.tableId);
  const partition = requirePartition(table.id, body.partition);
  const operator = (body.operator ?? '').trim();
  const reason = (body.reason ?? '').trim();
  if (!operator) throw badRequest('必须提供操作者（operator），用于审计');
  if (reason.length < 4) throw badRequest('必须填写恢复依据（reason，至少 4 个字符）');
  const ticket = (body.ticket ?? '').trim();
  const mode = ['point', 'version', 'label'].includes(body.mode) ? body.mode : 'version';
  const target = resolveTarget(table.id, body);
  const dryRun = body.dryRun === true;
  const conflictAction = ['pause', 'overwrite_target', 'keep_current', 'abort'].includes(body.conflictAction)
    ? body.conflictAction
    : 'pause';
  const fileSelection = ['all', 'changed', 'paths'].includes(body.fileSelection) ? body.fileSelection : 'all';
  const selectedPaths = Array.isArray(body.selectedPaths) ? body.selectedPaths.filter((p) => typeof p === 'string') : [];
  const settleMs = Math.max(0, Math.min(10_000, Number(body.settleMs ?? 0) || 0));

  if (!dryRun && activeJobForPartition(partition.id)) {
    const active = activeJobForPartition(partition.id);
    throw conflictError('该分区已有进行中的恢复任务；请等待其完成，先处理冲突或取消后再试', {
      activeJobId: active.id,
      activeJobState: active.state,
      partition: partition.name,
    });
  }

  const baseline = latestVersion(table.id);
  const baselineAt = nowIso();
  const live = buildManifest([partition]);
  const targetFiles = target.manifest.filter((f) => f.partition === partition.name);
  const liveByPath = new Map(live.map((f) => [f.path, f]));
  const targetByPath = new Map(targetFiles.map((f) => [f.path, f]));

  const diff = diffPartition({ table, partition: partition.name, targetVersion: target, liveFiles: live });
  const impact = computeImpact({ table, partition: partition.name, diff });

  const planned = planFileActions({ liveByPath, targetByPath, fileSelection, selectedPaths, target, baseline });
  const totalBytes = planned.reduce((sum, f) => sum + (f.target?.bytes ?? 0), 0);

  const id = newId('job_');
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO restore_jobs (id, table_id, partition_id, target_version_id, target_version_seq, target_at, target_label, mode, state, phase, result,
        check_state, conflict_action, file_selection, selected_paths_json, operator, reason, ticket, baseline_version_id, baseline_seq, baseline_at,
        settle_ms, dry_run, progress_pct, total_bytes, processed_bytes, file_total, file_processed, conflict_count, diff_json, impact_json, message,
        last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', '准备', '', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      table.id,
      partition.id,
      target.id,
      target.seq,
      body.at ? normalizeTime(body.at) : null,
      target.label ?? '',
      mode,
      conflictAction,
      fileSelection,
      toJson(selectedPaths),
      operator,
      reason,
      ticket,
      baseline?.id ?? null,
      baseline?.seq ?? null,
      baselineAt,
      settleMs,
      dryRun ? 1 : 0,
      totalBytes,
      planned.length,
      toJson(diff),
      toJson(impact),
      '恢复任务已创建',
      now,
      now,
      now,
    );

  const insertFile = getDb().prepare(
    `INSERT INTO job_files (id, job_id, path, partition_name, source_kind, source_version_id, source_version_seq, baseline_checksum, target_checksum,
      baseline_bytes, target_bytes, status, skip_reason, conflict_reason, verify_state, attempt, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 1, NULL, ?)`,
  );
  for (const item of planned) {
    insertFile.run(
      newId('jf_'),
      id,
      item.path,
      partition.name,
      item.sourceKind,
      item.sourceVersionId ?? null,
      item.sourceVersionSeq ?? null,
      item.baseline?.checksum ?? null,
      item.target?.checksum ?? null,
      item.baseline?.bytes ?? 0,
      item.target?.bytes ?? 0,
      item.status,
      item.skipReason ?? null,
      now,
    );
  }

  recordEvent({
    actor: operator,
    action: 'restore.requested',
    entityType: 'restore_job',
    entityId: id,
    tableId: table.id,
    partitionId: partition.id,
    jobId: id,
    versionId: target.id,
    reason,
    evidence: ticket || null,
    snapshot: {
      partition: partition.name,
      target: { id: target.id, seq: target.seq, label: target.label, createdAt: target.createdAt, snapshotHash: target.snapshotHash },
      baseline: baseline ? { id: baseline.id, seq: baseline.seq, createdAt: baseline.createdAt, snapshotHash: baseline.snapshotHash } : null,
      baselineAt,
      mode,
      dryRun,
      fileSelection,
      conflictAction,
      plan: planned.map((p) => ({
        path: p.path,
        action: p.status,
        baselineChecksum: p.baseline?.checksum ?? null,
        targetChecksum: p.target?.checksum ?? null,
      })),
      diffSummary: diff.summary,
    },
  });

  const job = getJob(id);
  if (dryRun) {
    finishDryRun(id, { diff, impact, planned });
    return getJob(id);
  }
  schedule(id, settleMs > 0 ? settleMs : 0);
  return job;
}

function planFileActions({ liveByPath, targetByPath, fileSelection, selectedPaths, target, baseline }) {
  const paths = [...new Set([...liveByPath.keys(), ...targetByPath.keys()])].sort();
  const selected = fileSelection === 'paths' ? new Set(selectedPaths) : null;
  const out = [];
  for (const path of paths) {
    const liveFile = liveByPath.get(path) ?? null;
    const targetFile = targetByPath.get(path) ?? null;
    if (selected && !selected.has(path)) {
      out.push({
        path,
        baseline: liveFile,
        target: targetFile,
        sourceKind: targetFile ? 'object' : 'delete',
        sourceVersionId: target.id,
        sourceVersionSeq: target.seq,
        status: 'skipped',
        skipReason: '未选择该文件',
      });
      continue;
    }
    if (!targetFile) {
      out.push({
        path,
        baseline: liveFile,
        target: null,
        sourceKind: 'delete',
        sourceVersionId: target.id,
        sourceVersionSeq: target.seq,
        status: 'pending',
      });
      continue;
    }
    if (liveFile && liveFile.checksum === targetFile.checksum) {
      out.push({
        path,
        baseline: liveFile,
        target: targetFile,
        sourceKind: 'object',
        sourceVersionId: target.id,
        sourceVersionSeq: target.seq,
        status: 'skipped',
        skipReason: '当前文件已与目标版本一致',
      });
      continue;
    }
    out.push({
      path,
      baseline: liveFile,
      target: targetFile,
      sourceKind: 'object',
      sourceVersionId: target.id,
      sourceVersionSeq: target.seq,
      status: 'pending',
    });
  }
  if (fileSelection === 'changed') {
    for (const item of out) {
      if (item.status === 'pending' && !item.target) item.status = 'skipped';
    }
  }
  return out;
}

function activeJobForPartition(partitionId) {
  const states = [...LOCK_STATES, 'queued'];
  const placeholders = states.map(() => '?').join(',');
  return (
    getDb()
      .prepare(`SELECT id, state FROM restore_jobs WHERE partition_id = ? AND state IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`)
      .get(partitionId, ...states) ?? null
  );
}

function finishDryRun(id, { diff, impact, planned }) {
  const changed = planned.filter((f) => f.status === 'pending').length;
  getDb()
    .prepare(
      `UPDATE restore_jobs SET state = 'completed', phase = '完成', result = 'dry_run', check_state = 'skipped',
        progress_pct = 100, file_processed = file_total, started_at = ?, finished_at = ?, updated_at = ?, last_heartbeat = ?,
        message = ? WHERE id = ?`,
    )
    .run(nowIso(), nowIso(), nowIso(), nowIso(), `演练完成：将变更 ${changed} 个文件、影响 ${diff.summary.rowsAdded + diff.summary.rowsRemoved + diff.summary.rowsChanged} 行、下游 ${impact.downstreamCount} 个任务`, id);
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

function schedule(id, delay = 0) {
  clearTimer(id);
  const timer = setTimeout(() => {
    timers.delete(id);
    step(id);
  }, delay);
  timer.unref?.();
  timers.set(id, timer);
}

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function step(id) {
  const job = getJob(id);
  if (!job || TERMINAL.has(job.state) || job.state === 'conflict' || job.state === 'paused') return;

  if (job.state === 'queued') {
    startJob(job);
    return;
  }
  if (job.state === 'checking') {
    runIntegrity(job);
    return;
  }
  if (job.state === 'running') {
    const next = getDb()
      .prepare("SELECT id, path FROM job_files WHERE job_id = ? AND status IN ('pending','writing') ORDER BY path ASC LIMIT 1")
      .get(id);
    if (!next) {
      const leftover = getDb().prepare("SELECT COUNT(*) AS n FROM job_files WHERE job_id = ? AND status = 'conflict'").get(id).n;
      if (leftover > 0) {
        const conflicts = collectConflicts(job.id);
        setJob(job.id, {
          state: 'conflict',
          phase: '暂停（冲突）',
          message: `仍有 ${leftover} 个文件等待冲突处理，恢复已暂停`,
          conflict_count: conflicts.length,
          conflict_json: toJson(conflicts),
          last_heartbeat: nowIso(),
        });
        return;
      }
      beginVerification(job);
      return;
    }
    applyFile(job, next.id);
    return;
  }
  if (job.state === 'verifying') {
    verifyJob(job);
    return;
  }
  if (job.state === 'finalizing') {
    finalizeJob(job);
    return;
  }
}

function startJob(job) {
  // Two jobs can be queued at once; only one may take the partition lock.
  const claimed = getDb()
    .prepare("UPDATE restore_jobs SET state = 'checking', phase = '完整性校验', started_at = ?, message = '校验目标版本对象完整性…', updated_at = ? WHERE id = ? AND state = 'queued'")
    .run(nowIso(), nowIso(), job.id);
  if (claimed.changes === 0) return;
  const rival = getDb()
    .prepare("SELECT id FROM restore_jobs WHERE partition_id = ? AND id != ? AND state IN ('checking','running','conflict','verifying','finalizing')")
    .get(job.partitionId, job.id);
  if (rival) {
    setJob(job.id, {
      state: 'failed',
      phase: '启动',
      result: 'partition_busy',
      message: '同一分区已有另一个恢复任务在执行，本任务未写入任何文件',
      finished_at: nowIso(),
      last_heartbeat: nowIso(),
      error_json: toJson({ kind: 'partition_busy', rivalJobId: rival.id }),
    });
    return;
  }
  schedule(job.id);
}

/**
 * Preflight does two things before any file is touched:
 *   1. every object the target version points at must exist in the content
 *      store with a matching hash (a damaged file blocks the whole job);
 *   2. every file's live checksum must still equal the baseline captured when
 *      the job was created. A mismatch means someone wrote concurrently in
 *      the meantime, which is surfaced as a conflict instead of being
 *      silently overwritten.
 */
function runIntegrity(job) {
  const target = getVersion(job.targetVersionId);
  const files = listJobFiles(job.id).filter((f) => f.sourceKind === 'object' && f.status !== 'skipped');
  const damaged = [];
  const checked = [];
  for (const file of files) {
    const entry = target.manifest.find((m) => m.partition === file.partition && m.path === file.path);
    if (!entry) {
      damaged.push({ path: file.path, reason: '目标版本清单中缺少该文件' });
      continue;
    }
    try {
      const buf = readObject(entry.checksum);
      checked.push({ path: file.path, checksum: entry.checksum, bytes: buf.length });
    } catch (err) {
      if (err instanceof CorruptionError) damaged.push({ path: file.path, checksum: entry.checksum, reason: err.message });
      else throw err;
    }
  }
  const integrity = { checked: checked.length, damaged, total: files.length, ok: damaged.length === 0, checkedAt: nowIso() };
  if (damaged.length > 0) {
    failIntegrity(job, integrity);
    return;
  }
  setJob(job.id, { check_state: 'passed', check_json: toJson(integrity), last_heartbeat: nowIso() });

  // ---- concurrent-write detection against the captured baseline ----
  // Every file in the plan is checked, including ones planned as "already
  // identical": a concurrent writer can change exactly those, and skipping the
  // check would let the restore silently ignore (or later clobber) that write.
  const planned = listJobFiles(job.id).filter((f) => f.status !== 'skipped' || !f.skipReason?.includes('未选择'));
  const conflicts = [];
  for (const file of planned) {
    if (!['pending', 'skipped'].includes(file.status)) continue;
    const live = inspectPage(file.partition, file.path);
    if ((live.checksum ?? null) !== (file.baselineChecksum ?? null)) conflicts.push({ file, live });
  }
  if (conflicts.length > 0) {
    for (const { file, live } of conflicts) {
      setFileStatus(file.id, 'conflict', { conflictReason: live.checksum === null ? 'concurrent_delete' : 'concurrent_write', verifyState: 'blocked' });
    }
    const first = conflicts[0].file;
    if (job.conflictAction === 'overwrite_target') {
      getDb().prepare("UPDATE job_files SET status = 'pending' WHERE job_id = ? AND status = 'conflict'").run(job.id);
      markConflictsResolved(job);
    } else if (job.conflictAction === 'keep_current') {
      getDb().prepare("UPDATE job_files SET status = 'kept', skip_reason = '按冲突策略保留当前文件' WHERE job_id = ? AND status = 'conflict'").run(job.id);
      markConflictsResolved(job);
    } else if (job.conflictAction === 'abort') {
      markConflictsResolved(job);
      cancelJob(job.id, { actor: job.operator, reason: '检测到并发写入，按策略中止并回滚', triggeredBy: 'policy' });
      return;
    } else {
      clearTimer(job.id);
      const list = collectConflicts(job.id);
      setJob(job.id, {
        state: 'conflict',
        phase: '暂停（冲突）',
        message: `检测到并发写入（${list.length} 个文件）：${first.path}${list.length > 1 ? ' 等' : ''}。恢复已暂停，等待选择`,
        conflict_count: list.length,
        conflict_json: toJson(list),
        last_heartbeat: nowIso(),
      });
      recordEvent({
        actor: 'system',
        action: 'restore.conflict_detected',
        entityType: 'restore_job',
        entityId: job.id,
        tableId: job.tableId,
        partitionId: job.partitionId,
        versionId: job.targetVersionId,
        jobId: job.id,
        reason: job.reason,
        snapshot: {
          stage: 'preflight',
          conflicts: list.map((c) => ({
            path: c.path,
            baselineChecksum: c.baselineChecksum,
            liveChecksum: c.liveChecksum,
            targetChecksum: c.targetChecksum,
          })),
          options: ['overwrite_target', 'keep_current', 'abort'],
        },
      });
      return;
    }
  }

  setJob(job.id, {
    state: 'running',
    phase: '写入',
    message: '完整性校验通过，开始写入目标文件',
    progress_pct: 2,
    last_heartbeat: nowIso(),
  });
  schedule(job.id, paceDelay(job.fileTotal));
}

function markConflictsResolved(job, conflicts) {
  const list = collectConflicts(job.id);
  setJob(job.id, { conflict_count: list.length, conflict_json: toJson(list), last_heartbeat: nowIso() });
}

function failIntegrity(job, integrity) {
  setJob(job.id, {
    state: 'failed',
    phase: '完整性校验',
    result: 'integrity_failed',
    check_state: 'failed',
    check_json: toJson(integrity),
    message: `目标版本有 ${integrity.damaged.length} 个文件损坏或缺失，已阻止恢复`,
    finished_at: nowIso(),
    progress_pct: 0,
    error_json: toJson({ kind: 'integrity', damaged: integrity.damaged }),
  });
  getDb().prepare("UPDATE job_files SET status = 'failed', error = '目标对象损坏或缺失' WHERE job_id = ? AND status IN ('pending','writing')").run(job.id);
  recordEvent({
    actor: 'system',
    action: 'restore.integrity_failed',
    entityType: 'restore_job',
    entityId: job.id,
    tableId: job.tableId,
    partitionId: job.partitionId,
    jobId: job.id,
    versionId: job.targetVersionId,
    reason: job.reason,
    snapshot: { damaged: integrity.damaged, checked: integrity.checked },
  });
}

function applyFile(job, fileId) {
  const file = getDb().prepare('SELECT * FROM job_files WHERE id = ? AND job_id = ?').get(fileId, job.id);
  if (!file) return;
  const partitionName = file.partition_name;
  const live = inspectPage(partitionName, file.path);
  const baselineChecksum = file.baseline_checksum;

  if (live.checksum === file.target_checksum) {
    setFileStatus(file.id, 'skipped', { skipReason: '当前文件已与目标版本一致' });
    bumpProgress(job);
    return;
  }
  if ((live.checksum ?? null) !== (baselineChecksum ?? null)) {
    handleConflict(job, file, live);
    return;
  }

  try {
    if (file.target_checksum === null) {
      if (live.checksum !== null) {
        const backup = writeBackup(job.id, partitionName, file.path, readLive(partitionName, file.path) ?? Buffer.alloc(0));
        getDb().prepare('UPDATE job_files SET baseline_bytes = ? WHERE id = ?').run(backup.bytes, file.id);
      }
      removePage(partitionName, file.path);
      setFileStatus(file.id, 'deleted', { verifyState: 'pending' });
    } else {
      const buf = readObject(file.target_checksum);
      if (live.checksum !== null) {
        writeBackup(job.id, partitionName, file.path, readLive(partitionName, file.path) ?? Buffer.alloc(0));
      }
      const written = writePageAtomic(partitionName, file.path, buf);
      if (written.checksum !== file.target_checksum) {
        throw new CorruptionError('写入后校验和不一致');
      }
      setFileStatus(file.id, 'written', { verifyState: 'pending', targetBytes: written.bytes });
    }
    bumpProgress(job);
  } catch (err) {
    const reason = err instanceof CorruptionError ? err.message : err.message ?? String(err);
    setFileStatus(file.id, 'failed', { error: reason });
    failJob(job, {
      kind: 'write_failed',
      path: file.path,
      reason,
    });
  }
}

function bumpProgress(job) {
  const counts = getDb()
    .prepare(
      `SELECT
        SUM(CASE WHEN status IN ('written','deleted','skipped','kept') THEN 1 ELSE 0 END) AS done,
        COUNT(*) AS total
       FROM job_files WHERE job_id = ?`,
    )
    .get(job.id);
  const processed = getDb()
    .prepare("SELECT COALESCE(SUM(target_bytes), 0) AS bytes FROM job_files WHERE job_id = ? AND status IN ('written','deleted')")
    .get(job.id).bytes;
  const pct = counts.total ? Math.min(99, Math.round((counts.done / counts.total) * 100)) : 99;
  setJob(job.id, {
    file_processed: counts.done,
    progress_pct: pct,
    processed_bytes: processed,
    last_heartbeat: nowIso(),
  });
  schedule(job.id, counts.done >= counts.total ? 0 : paceDelay(counts.total));
}

function setFileStatus(id, status, patch = {}) {
  const cols = ['status = ?'];
  const vals = [status];
  for (const [key, value] of Object.entries(patch)) {
    const map = { skipReason: 'skip_reason', conflictReason: 'conflict_reason', verifyState: 'verify_state', error: 'error', targetBytes: 'target_bytes', attempt: 'attempt' };
    cols.push(`${map[key] ?? key} = ?`);
    vals.push(value);
  }
  cols.push('updated_at = ?');
  vals.push(nowIso());
  getDb().prepare(`UPDATE job_files SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
}

/* ------------------------------------------------------------------ */
/* Conflicts                                                           */
/* ------------------------------------------------------------------ */

function handleConflict(job, file, live) {
  const latestCommit = getDb()
    .prepare('SELECT * FROM commits WHERE partition_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
    .get(job.partitionId, job.baselineAt);
  const reason = live.checksum === null ? 'concurrent_delete' : 'concurrent_write';
  setFileStatus(file.id, 'conflict', {
    conflictReason: reason,
    verifyState: 'blocked',
  });

  if (job.conflictAction === 'overwrite_target') {
    setFileStatus(file.id, 'writing', { conflictReason: reason });
    recordConflict(job, file, live, latestCommit, reason, 'overwritten');
    applyOverwriting(job, file);
    return;
  }
  if (job.conflictAction === 'keep_current') {
    setFileStatus(file.id, 'kept', { conflictReason: reason });
    recordConflict(job, file, live, latestCommit, reason, 'kept');
    bumpProgress(job);
    return;
  }
  if (job.conflictAction === 'abort') {
    recordConflict(job, file, live, latestCommit, reason, 'aborted');
    clearTimer(job.id);
    cancelJob(job.id, { actor: job.operator, reason: '检测到并发写入，按策略中止并回滚', triggeredBy: 'policy' });
    return;
  }

  // default: pause and wait for an operator decision
  clearTimer(job.id);
  const conflicts = collectConflicts(job.id);
  setJob(job.id, {
    state: 'conflict',
    phase: '暂停（冲突）',
    message: `检测到并发写入：${file.path}。恢复已暂停，等待选择`,
    conflict_count: conflicts.length,
    conflict_json: toJson(conflicts),
    last_heartbeat: nowIso(),
  });
  recordEvent({
    actor: 'system',
    action: 'restore.conflict_detected',
    entityType: 'restore_job',
    entityId: job.id,
    tableId: job.tableId,
    partitionId: job.partitionId,
    versionId: job.targetVersionId,
    jobId: job.id,
    reason: job.reason,
    snapshot: {
      path: file.path,
      conflictReason: reason,
      baselineChecksum: file.baseline_checksum,
      liveChecksum: live.checksum,
      targetChecksum: file.target_checksum,
      concurrentCommit: latestCommit ? { id: latestCommit.id, actor: latestCommit.actor, message: latestCommit.message, at: latestCommit.created_at } : null,
      options: ['overwrite_target', 'keep_current', 'abort'],
    },
  });
}

function applyOverwriting(job, file) {
  try {
    if (file.target_checksum === null) {
      const live = readLive(file.partition_name, file.path);
      if (live) writeBackup(job.id, file.partition_name, file.path, live);
      removePage(file.partition_name, file.path);
      setFileStatus(file.id, 'deleted', { verifyState: 'pending' });
    } else {
      const buf = readObject(file.target_checksum);
      const live = readLive(file.partition_name, file.path);
      if (live) writeBackup(job.id, file.partition_name, file.path, live);
      writePageAtomic(file.partition_name, file.path, buf);
      setFileStatus(file.id, 'written', { verifyState: 'pending' });
    }
    bumpProgress(job);
  } catch (err) {
    setFileStatus(file.id, 'failed', { error: err.message });
    failJob(job, { kind: 'write_failed', path: file.path, reason: err.message });
  }
}

function recordConflict(job, file, live, commit, reason, resolution) {
  const conflicts = collectConflicts(job.id);
  setJob(job.id, { conflict_count: conflicts.length, conflict_json: toJson(conflicts), last_heartbeat: nowIso() });
  recordEvent({
    actor: job.operator,
    action: 'restore.conflict_resolved',
    entityType: 'restore_job',
    entityId: job.id,
    tableId: job.tableId,
    partitionId: job.partitionId,
    jobId: job.id,
    versionId: job.targetVersionId,
    reason: job.reason,
    snapshot: {
      path: file.path,
      conflictReason: reason,
      resolution,
      liveChecksum: live.checksum,
      targetChecksum: file.target_checksum,
      concurrentCommit: commit ? { id: commit.id, actor: commit.actor, message: commit.message, at: commit.created_at } : null,
    },
  });
}

function collectConflicts(jobId) {
  const rows = getDb()
    .prepare("SELECT * FROM job_files WHERE job_id = ? AND conflict_reason IS NOT NULL ORDER BY path ASC")
    .all(jobId);
  return rows.map((r) => ({
    fileId: r.id,
    path: r.path,
    reason: r.conflict_reason,
    status: r.status,
    baselineChecksum: r.baseline_checksum,
    targetChecksum: r.target_checksum,
    liveChecksum: inspectPage(r.partition_name, r.path).checksum,
    options: ['overwrite_target', 'keep_current', 'abort'],
  }));
}

export function resolveConflict(jobId, { action, operator, reason, ticket }) {
  const job = getJob(jobId);
  if (!job) throw new HttpError(404, 'not_found', `恢复任务 ${jobId} 不存在`);
  if (job.state !== 'conflict') throw conflictError('该任务当前不处于冲突暂停状态');
  if (!['overwrite_target', 'keep_current', 'abort'].includes(action)) throw badRequest('action 必须是 overwrite_target / keep_current / abort');
  if (!operator || operator.trim().length < 1) throw badRequest('解决冲突必须提供操作者（operator）');
  if (!reason || reason.trim().length < 4) throw badRequest('解决冲突必须填写依据（reason，至少 4 个字符）');

  recordEvent({
    actor: operator,
    action: 'restore.conflict_decision',
    entityType: 'restore_job',
    entityId: job.id,
    tableId: job.tableId,
    partitionId: job.partitionId,
    jobId: job.id,
    versionId: job.targetVersionId,
    reason,
    evidence: ticket || null,
    snapshot: { action, conflicts: job.conflicts, decidedAt: nowIso() },
  });

  if (action === 'abort') {
    cancelJob(job.id, { actor: operator, reason, triggeredBy: 'conflict_resolution' });
    return getJob(job.id);
  }

  if (action === 'overwrite_target') {
    getDb()
      .prepare("UPDATE job_files SET status = 'writing', error = NULL WHERE job_id = ? AND status = 'conflict'")
      .run(job.id);
  } else {
    getDb()
      .prepare("UPDATE job_files SET status = 'kept', skip_reason = '按冲突策略保留当前文件' WHERE job_id = ? AND status = 'conflict'")
      .run(job.id);
  }
  const conflicts = collectConflicts(job.id);
  setJob(job.id, {
    state: 'running',
    phase: '写入',
    conflict_action: action,
    conflict_count: conflicts.length,
    conflict_json: toJson(conflicts),
    message: action === 'overwrite_target' ? '已选择覆盖冲突文件，继续恢复' : '已选择保留冲突文件，继续恢复',
    last_heartbeat: nowIso(),
  });
  schedule(job.id);
  return getJob(job.id);
}

/* ------------------------------------------------------------------ */
/* Verification / completion                                           */
/* ------------------------------------------------------------------ */

function beginVerification(job) {
  setJob(job.id, { state: 'verifying', phase: '回读校验', progress_pct: 99, message: '回读并校验已写入文件…', last_heartbeat: nowIso() });
  schedule(job.id);
}

function verifyJob(job) {
  const target = getVersion(job.targetVersionId);
  const files = listJobFiles(job.id).filter((f) => ['written', 'deleted'].includes(f.status));
  const failures = [];
  for (const file of files) {
    const live = inspectPage(file.partition, file.path);
    const expected = file.targetChecksum;
    if ((live.checksum ?? null) !== (expected ?? null)) {
      failures.push({
        path: file.path,
        expected,
        actual: live.checksum,
        reason: expected === null ? '文件删除未生效' : '回读校验和不一致',
      });
      setFileStatus(file.id, 'failed', { verifyState: 'failed', error: '回读校验失败' });
    } else {
      setFileStatus(file.id, file.status, { verifyState: 'verified' });
    }
  }
  if (failures.length > 0) {
    failJob(job, { kind: 'verify_failed', failures }, { rollback: true });
    return;
  }
  setJob(job.id, { state: 'finalizing', phase: '提交版本', check_state: 'passed', message: '回读校验通过，生成恢复版本…' });
  schedule(job.id);
}

function finalizeJob(job) {
  const target = getVersion(job.targetVersionId);
  const processed = getDb()
    .prepare("SELECT * FROM job_files WHERE job_id = ? AND status IN ('written','deleted','kept') ORDER BY path ASC")
    .all(job.id);
  const changed = processed.some((f) => f.status === 'written' || f.status === 'deleted');

  if (!changed) {
    setJob(job.id, {
      state: 'completed',
      phase: '完成',
      result: 'noop',
      progress_pct: 100,
      message: '当前分区内容已与目标版本一致，无需写入（重复恢复无副作用）',
      finished_at: nowIso(),
      last_heartbeat: nowIso(),
    });
    recordEvent({
      actor: job.operator,
      action: 'restore.noop',
      entityType: 'restore_job',
      entityId: job.id,
      tableId: job.tableId,
      partitionId: job.partitionId,
      jobId: job.id,
      versionId: target.id,
      reason: job.reason,
      evidence: job.ticket || null,
      snapshot: {
        targetVersion: { id: target.id, seq: target.seq, snapshotHash: target.snapshotHash },
        baselineVersion: { id: job.baselineVersionId, seq: job.baselineSeq },
        files: processed.map((f) => ({ path: f.path, status: f.status })),
      },
    });
    return;
  }

  const partitionRow = getPartition(job.tableId, job.partitionId);
  const changes = processed.map((f) => ({
    path: f.path,
    action: f.status === 'deleted' ? 'delete' : f.status === 'kept' ? 'keep' : 'write',
    beforeChecksum: f.baseline_checksum,
    afterChecksum: f.target_checksum,
    targetVersionSeq: target.seq,
  }));
  const version = createVersion({
    tableId: job.tableId,
    kind: 'restore',
    label: `恢复至 v${target.seq}${target.label ? ` · ${target.label}` : ''}`,
    reason: job.reason,
    author: job.operator,
    changes: [{ partition: partitionRow?.name ?? '', files: changes }],
    baselineId: job.baselineVersionId,
    restoreJobId: job.id,
    partitions: listPartitions(job.tableId),
  });
  setJob(job.id, {
    state: 'completed',
    phase: '完成',
    result: 'restored',
    progress_pct: 100,
    new_version_id: version.id,
    message: `恢复完成，生成新版本 v${version.seq}`,
    finished_at: nowIso(),
    last_heartbeat: nowIso(),
  });
  recordEvent({
    actor: job.operator,
    action: 'restore.completed',
    entityType: 'restore_job',
    entityId: job.id,
    tableId: job.tableId,
    partitionId: job.partitionId,
    jobId: job.id,
    versionId: version.id,
    reason: job.reason,
    evidence: job.ticket || null,
    snapshot: {
      partition: partitionRow?.name,
      targetVersion: { id: target.id, seq: target.seq, label: target.label, snapshotHash: target.snapshotHash },
      baselineVersion: { id: job.baselineVersionId, seq: job.baselineSeq },
      baselineAt: job.baselineAt,
      newVersion: { id: version.id, seq: version.seq, snapshotHash: version.snapshotHash },
      fileCount: processed.length,
      conflicts: job.conflicts?.length ?? 0,
      changedFiles: processed.filter((f) => f.status !== 'kept').length,
    },
  });
  clearStaging(job.id);
}

function failJob(job, error, { rollback = true } = {}) {
  clearTimer(job.id);
  let rollbackReport = null;
  if (rollback) rollbackReport = rollbackApplied(job.id);
  const current = getJob(job.id);
  setJob(job.id, {
    state: 'failed',
    phase: '失败',
    result: error.kind ?? 'failed',
    error_json: toJson({ ...error, rollback: rollbackReport }),
    message: error.kind === 'verify_failed' ? '回读校验失败，已回滚到恢复前状态' : `恢复失败：${error.reason ?? '未知错误'}`,
    reverted: rollbackReport?.ok ? 1 : 0,
    finished_at: nowIso(),
    last_heartbeat: nowIso(),
  });
  recordEvent({
    actor: 'system',
    action: 'restore.failed',
    entityType: 'restore_job',
    entityId: job.id,
    tableId: job.tableId,
    partitionId: job.partitionId,
    jobId: job.id,
    versionId: job.targetVersionId,
    reason: job.reason,
    snapshot: { error, rollback: rollbackReport, progress: { files: current?.fileProcessed, pct: current?.progressPct } },
  });
}

/**
 * Undo every applied file using the staging backups captured before the write.
 * Used when verification fails or an operator aborts mid-restore.
 */
export function rollbackApplied(jobId) {
  const files = getDb()
    .prepare("SELECT * FROM job_files WHERE job_id = ? AND status IN ('written','deleted') ORDER BY path DESC")
    .all(jobId);
  const results = [];
  for (const file of files) {
    const backup = readBackup(jobId, file.partition_name, file.path);
    try {
      if (backup === null) {
        removePage(file.partition_name, file.path);
        results.push({ path: file.path, restored: 'absent' });
      } else {
        writePageAtomic(file.partition_name, file.path, backup);
        results.push({ path: file.path, restored: 'backup', bytes: backup.length });
      }
      setFileStatus(file.id, 'rolled_back', { verifyState: 'rolled_back' });
    } catch (err) {
      results.push({ path: file.path, restored: 'failed', error: err.message });
    }
  }
  return {
    ok: results.every((r) => r.restored !== 'failed'),
    files: results,
    at: nowIso(),
  };
}

export function cancelJob(jobId, { actor, reason, triggeredBy = 'operator' } = {}) {
  const job = getJob(jobId);
  if (!job) throw new HttpError(404, 'not_found', `恢复任务 ${jobId} 不存在`);
  if (TERMINAL.has(job.state)) throw conflictError('任务已结束，无法取消');
  clearTimer(jobId);
  const rollback = job.startedAt ? rollbackApplied(jobId) : { ok: true, files: [], at: nowIso() };
  getDb()
    .prepare("UPDATE job_files SET status = 'cancelled' WHERE job_id = ? AND status IN ('pending','writing','conflict')")
    .run(jobId);
  setJob(jobId, {
    state: 'cancelled',
    phase: '已取消',
    result: 'cancelled',
    message: reason ? `已取消：${reason}` : '已取消',
    reverted: rollback.ok ? 1 : 0,
    error_json: toJson({ kind: 'cancelled', rollback }),
    finished_at: nowIso(),
    last_heartbeat: nowIso(),
    progress_pct: 100,
  });
  recordEvent({
    actor: actor ?? job.operator,
    action: 'restore.cancelled',
    entityType: 'restore_job',
    entityId: job.id,
    tableId: job.tableId,
    partitionId: job.partitionId,
    jobId: job.id,
    versionId: job.targetVersionId,
    reason: reason ?? job.reason,
    snapshot: { triggeredBy, rollback },
  });
  clearStaging(jobId);
  return getJob(jobId);
}

export function resumeJob(jobId, { actor, reason } = {}) {
  const job = getJob(jobId);
  if (!job) throw new HttpError(404, 'not_found', `恢复任务 ${jobId} 不存在`);
  if (job.state !== 'paused') throw conflictError('只有已暂停的任务可以恢复执行');
  setJob(jobId, {
    state: job.checkState === 'passed' ? 'running' : 'checking',
    phase: job.checkState === 'passed' ? '写入' : '完整性校验',
    message: '任务已恢复执行',
    last_heartbeat: nowIso(),
  });
  recordEvent({
    actor: actor ?? job.operator,
    action: 'restore.resumed',
    entityType: 'restore_job',
    entityId: job.id,
    tableId: job.tableId,
    partitionId: job.partitionId,
    jobId: job.id,
    versionId: job.targetVersionId,
    reason: reason ?? job.reason,
    snapshot: { previousState: 'paused' },
  });
  schedule(jobId);
  return getJob(jobId);
}

/**
 * On boot, any job that was mid-flight has lost its scheduler. Rather than
 * pretending it is still running, park it in `paused` so an operator can
 * inspect the partial state and decide whether to resume or roll back.
 */
export function recoverInterruptedJobs() {
  const states = [...WORK_STATES];
  const placeholders = states.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT id FROM restore_jobs WHERE state IN (${placeholders})`).all(...states);
  for (const row of rows) {
    clearTimer(row.id);
    setJob(row.id, {
      state: 'paused',
      message: '服务重启中断了任务，已暂停；请检查部分写入状态后恢复或取消',
      last_heartbeat: nowIso(),
    });
  }
  const queued = getDb().prepare("SELECT id FROM restore_jobs WHERE state = 'queued'").all();
  for (const row of queued) schedule(row.id, 0);
  return rows.length + queued.length;
}

export function jobProgress(jobId) {
  const job = getJob(jobId);
  if (!job) throw new HttpError(404, 'not_found', `恢复任务 ${jobId} 不存在`);
  const files = listJobFiles(jobId);
  const counts = {};
  for (const f of files) counts[f.status] = (counts[f.status] ?? 0) + 1;
  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    result: job.result,
    progressPct: job.progressPct,
    fileTotal: job.fileTotal,
    fileProcessed: job.fileProcessed,
    processedBytes: job.processedBytes,
    totalBytes: job.totalBytes,
    counts,
    message: job.message,
    newVersionId: job.newVersionId,
    updatedAt: job.updatedAt,
  };
}
