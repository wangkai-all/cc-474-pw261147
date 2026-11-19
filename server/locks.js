import { getDb } from './db.js';

/**
 * Partition-level advisory lock shared by restore jobs and writers.
 *
 * A lock is derived from restore_jobs rows in an active state, so it survives
 * process restarts (the in-memory scheduler is rebuilt from the database).
 * States that hold the lock: running, conflict, awaiting_approval,
 * verifying, finalizing. Paused / cancelled / completed jobs release it.
 */
export const LOCKED_STATES = ['running', 'conflict', 'awaiting_approval', 'verifying', 'finalizing'];

export function activeRestoreForPartition(partitionId) {
  const placeholders = LOCKED_STATES.map(() => '?').join(',');
  const row = getDb()
    .prepare(
      `SELECT id, state, dry_run, target_version_seq, created_at FROM restore_jobs
       WHERE partition_id = ? AND state IN (${placeholders})
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(partitionId, ...LOCKED_STATES);
  return row ?? null;
}

export function activeRestoreForTable(tableId) {
  const placeholders = LOCKED_STATES.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT id, partition_id, state, dry_run, target_version_seq FROM restore_jobs
       WHERE table_id = ? AND state IN (${placeholders}) ORDER BY created_at DESC`,
    )
    .all(tableId, ...LOCKED_STATES);
}

export function partitionLockMap(tableId) {
  const map = new Map();
  for (const job of activeRestoreForTable(tableId)) {
    if (!map.has(job.partition_id)) map.set(job.partition_id, job);
  }
  return map;
}
