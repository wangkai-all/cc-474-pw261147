import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let dataDir = process.env.TV_DATA_DIR
  ? path.resolve(process.env.TV_DATA_DIR)
  : path.resolve(process.cwd(), 'data');

export const getDataDir = () => dataDir;
export const getDbPath = () => path.join(dataDir, 'timevault.db');
export const getPagesDir = () => path.join(dataDir, 'pages');
export const getObjectsDir = () => path.join(dataDir, 'objects');
export const getStagingDir = () => path.join(dataDir, 'staging');
export const getRestoreDir = () => path.join(dataDir, 'restores');

export function configureDataDir(dir) {
  closeDb();
  dataDir = path.resolve(dir);
  ensureDirs();
}

export function ensureDirs() {
  for (const dir of [dataDir, getPagesDir(), getObjectsDir(), getStagingDir(), getRestoreDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  partition_key TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  downstream_json TEXT NOT NULL DEFAULT '[]',
  owner TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  snapshot_hash TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL DEFAULT '[]',
  baseline_id TEXT,
  restore_job_id TEXT,
  changes_json TEXT NOT NULL DEFAULT '[]',
  damaged_files INTEGER NOT NULL DEFAULT -1,
  UNIQUE (table_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_versions_table_seq ON versions(table_id, seq);
CREATE INDEX IF NOT EXISTS idx_versions_created ON versions(created_at);

CREATE TABLE IF NOT EXISTS partitions (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  file_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (table_id, name)
);

CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  partition_id TEXT NOT NULL REFERENCES partitions(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  base_version_id TEXT REFERENCES versions(id),
  kind TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commits_partition ON commits(partition_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  partition_id TEXT REFERENCES partitions(id) ON DELETE SET NULL,
  version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'data',
  row_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS restore_jobs (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  partition_id TEXT NOT NULL REFERENCES partitions(id) ON DELETE CASCADE,
  target_version_id TEXT REFERENCES versions(id),
  target_version_seq INTEGER,
  target_at TEXT,
  target_label TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  check_state TEXT NOT NULL DEFAULT 'pending',
  conflict_action TEXT NOT NULL DEFAULT 'keep_current',
  file_selection TEXT NOT NULL DEFAULT 'all',
  selected_paths_json TEXT NOT NULL DEFAULT '[]',
  operator TEXT NOT NULL,
  reason TEXT NOT NULL,
  ticket TEXT NOT NULL DEFAULT '',
  baseline_version_id TEXT,
  baseline_seq INTEGER,
  baseline_at TEXT NOT NULL,
  settle_ms INTEGER NOT NULL DEFAULT 0,
  settle_until TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  progress_pct INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  processed_bytes INTEGER NOT NULL DEFAULT 0,
  file_total INTEGER NOT NULL DEFAULT 0,
  file_processed INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  diff_json TEXT,
  impact_json TEXT,
  check_json TEXT,
  conflict_json TEXT,
  error_json TEXT,
  message TEXT NOT NULL DEFAULT '',
  last_heartbeat TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  new_version_id TEXT,
  reverted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_table ON restore_jobs(table_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_partition ON restore_jobs(partition_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON restore_jobs(state);

CREATE TABLE IF NOT EXISTS job_files (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES restore_jobs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  partition_name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_version_id TEXT,
  source_version_seq INTEGER,
  baseline_checksum TEXT,
  target_checksum TEXT,
  baseline_bytes INTEGER NOT NULL DEFAULT 0,
  target_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  skip_reason TEXT,
  conflict_reason TEXT,
  verify_state TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, path)
);
CREATE INDEX IF NOT EXISTS idx_job_files_job ON job_files(job_id, status);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  table_id TEXT,
  partition_id TEXT,
  job_id TEXT,
  version_id TEXT,
  reason TEXT,
  evidence TEXT,
  snapshot_json TEXT,
  prev_hash TEXT,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_table ON audit_events(table_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_events(job_id, at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db = null;

export function getDb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(getDbPath());
  db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}

export function removeDbFiles(dir = dataDir) {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = path.join(dir, `timevault.db${suffix}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

export function tx(fn) {
  const conn = getDb();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function getMeta(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
