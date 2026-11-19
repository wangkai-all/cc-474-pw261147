import fs from 'node:fs';
import path from 'node:path';
import { getDb, tx, getMeta, setMeta } from './db.js';
import { getDataDir, getPagesDir } from './paths.js';
import { nowIso, toJson } from './util.js';
import { ensurePartition, createVersion, listPartitions } from './tables.js';
import { writePageAtomic } from './storage.js';
import { recordEvent, resetAuditCache } from './audit.js';

const CITIES = ['上海', '北京', '深圳', '杭州', '成都', '广州', '武汉', '南京'];
const CHANNELS = ['app', 'web', 'store', 'partner'];
const STATUSES = ['paid', 'refunded', 'pending', 'settled'];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function money(rand, min, max) {
  return Number((min + rand() * (max - min)).toFixed(2));
}

function makeOrders(rand, partition, count) {
  const rows = [];
  const city = partition.replace(/^city=/, '');
  for (let i = 0; i < count; i += 1) {
    rows.push({
      order_id: `${partition}-${String(i + 1).padStart(4, '0')}`,
      user_id: `u_${Math.floor(rand() * 5000).toString().padStart(5, '0')}`,
      city,
      channel: pick(rand, CHANNELS),
      status: pick(rand, STATUSES),
      amount: money(rand, 9, 2400),
      currency: 'CNY',
      created_at: `2026-10-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}T${String(Math.floor(rand() * 24)).padStart(2, '0')}:00:00Z`,
      updated_at: `2026-11-${String(1 + Math.floor(rand() * 18)).padStart(2, '0')}T08:00:00Z`,
    });
  }
  return rows;
}

function makeShipments(rand, partition, count) {
  const rows = [];
  const city = partition.replace(/^city=/, '');
  for (let i = 0; i < count; i += 1) {
    rows.push({
      shipment_id: `${partition}-S${String(i + 1).padStart(4, '0')}`,
      order_id: `${partition}-${String(1 + Math.floor(rand() * count)).padStart(4, '0')}`,
      carrier: pick(rand, ['SF', 'JD', 'ZTO', 'YTO']),
      city,
      status: pick(rand, ['created', 'in_transit', 'delivered', 'returned']),
      fee: money(rand, 3, 60),
      shipped_at: `2026-11-${String(1 + Math.floor(rand() * 18)).padStart(2, '0')}T${String(Math.floor(rand() * 24)).padStart(2, '0')}:00:00Z`,
    });
  }
  return rows;
}

function writePartition(partition, files, rowsByFile) {
  for (const file of files) writePageAtomic(partition, file, Buffer.from(rowsByFile[file], 'utf8'));
}

export function isSeeded() {
  return getMeta('seeded', null) !== null;
}

export function seedDatabase({ force = false, at = null } = {}) {
  if (isSeeded() && !force) return { seeded: false, reason: 'already_seeded' };
  const db = getDb();
  const base = at ?? Date.now();
  const t0 = new Date(base - 1000 * 60 * 60 * 5).toISOString(); // 5h ago
  const step = 1000 * 60 * 7; // 7 minutes between versions

  resetAuditCache();
  db.exec('PRAGMA foreign_keys = OFF');
  tx((conn) => {
    for (const table of ['audit_events', 'job_files', 'restore_jobs', 'commits', 'versions', 'partitions', 'files', 'tables', 'meta']) {
      conn.exec(`DELETE FROM ${table}`);
    }
    if (force) {
      // clear live pages so re-seeding is deterministic
      const pages = getPagesDir();
      for (const entry of fs.readdirSync(pages)) {
        if (entry === 'objects' || entry === 'staging' || entry === 'restores' || entry.endsWith('.db')) continue;
        fs.rmSync(path.join(pages, entry), { recursive: true, force: true });
      }
    }
  });
  db.exec('PRAGMA foreign_keys = ON');

  const ordersTable = {
    id: 'tbl_orders',
    name: 'dwd_orders',
    description: '订单事实表，按城市分区，供营收看板与对账任务消费',
    partitionKey: 'order_id',
    columns: [
      { name: 'order_id', type: 'string', key: true },
      { name: 'user_id', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'channel', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'amount', type: 'decimal(12,2)' },
      { name: 'currency', type: 'string' },
      { name: 'created_at', type: 'timestamp' },
      { name: 'updated_at', type: 'timestamp' },
    ],
    downstream: [
      { id: 'ds_revenue_daily', name: '营收日汇总', type: 'dashboard', owner: 'BI 团队', criticality: 'high', slaMinutes: 30, schedule: '每天 07:00', partitions: ['*'], columns: ['amount', 'status'] },
      { id: 'ds_recon', name: '支付对账任务', type: 'job', owner: '结算平台', criticality: 'critical', slaMinutes: 15, schedule: '每小时', partitions: ['city=shanghai', 'city=beijing'], columns: ['order_id', 'amount', 'status'] },
      { id: 'ds_risk', name: '风控特征回填', type: 'pipeline', owner: '风控团队', criticality: 'medium', slaMinutes: 120, schedule: '每 4 小时', partitions: ['*'], columns: ['user_id', 'amount'] },
      { id: 'ds_export', name: '城市运营月报导出', type: 'export', owner: '运营团队', criticality: 'low', slaMinutes: 1440, schedule: '每月 1 日', partitions: ['city=chengdu'], columns: ['city', 'channel'] },
      { id: 'ds_unrelated', name: '广告归因模型', type: 'pipeline', owner: '增长团队', criticality: 'medium', schedule: '每天 03:00', partitions: ['partition=unused'], columns: ['channel'] },
    ],
  };

  const shipTable = {
    id: 'tbl_shipments',
    name: 'dwd_shipments',
    description: '物流运单表，按城市分区',
    partitionKey: 'shipment_id',
    columns: [
      { name: 'shipment_id', type: 'string', key: true },
      { name: 'order_id', type: 'string' },
      { name: 'carrier', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'fee', type: 'decimal(8,2)' },
      { name: 'shipped_at', type: 'timestamp' },
    ],
    downstream: [
      { id: 'ds_logi', name: '物流时效看板', type: 'dashboard', owner: '履约团队', criticality: 'high', slaMinutes: 60, schedule: '每小时', partitions: ['*'], columns: ['status', 'fee'] },
    ],
  };

  const now = nowIso();
  for (const table of [ordersTable, shipTable]) {
    db.prepare('INSERT INTO tables (id, name, description, partition_key, columns_json, downstream_json, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      table.id,
      table.name,
      table.description,
      table.partitionKey,
      toJson(table.columns),
      toJson(table.downstream),
      table.id === 'tbl_orders' ? '数据平台 / 李京' : '数据平台 / 王点',
      t0,
    );
  }

  const ordersPartitions = ['city=shanghai', 'city=beijing', 'city=chengdu', 'city=hangzhou'];
  const shipPartitions = ['city=shanghai', 'city=beijing'];

  for (const name of ordersPartitions) ensurePartition('tbl_orders', name, name.split('=')[1]);
  for (const name of shipPartitions) ensurePartition('tbl_shipments', name, name.split('=')[1]);

  // ---------------------------------------------------------------
  // Build a believable history: each step writes to one partition
  // and commits a new table version.
  // ---------------------------------------------------------------
  const rand = rng(20261119);
  const ordersFiles = {};
  for (const part of ordersPartitions) {
    const count = part === 'city=shanghai' ? 24 : part === 'city=beijing' ? 18 : 12;
    ordersFiles[part] = {
      'part-000.ndjson': serialize(makeOrders(rand, part, Math.ceil(count / 2))),
      'part-001.ndjson': serialize(makeOrders(rand, part, Math.floor(count / 2))),
    };
    writePartition(part, Object.keys(ordersFiles[part]), ordersFiles[part]);
  }
  for (const part of shipPartitions) {
    ordersFiles[`ship:${part}`] = { 'part-000.ndjson': serialize(makeShipments(rand, part, 14)) };
    writePartition(part, ['part-000.ndjson'], ordersFiles[`ship:${part}`]);
  }

  let clock = base - 1000 * 60 * 250; // 4h10m ago
  const taper = 1000 * 60 * 9;
  const nextTime = () => {
    const t = new Date(clock).toISOString();
    clock += taper;
    return t;
  };

  const events = [];

  const v1 = createVersion({ tableId: 'tbl_orders', kind: 'commit', label: '初始快照', reason: '首次接入版本管理', author: '李京', changes: [], partitions: listPartitions('tbl_orders'), at: nextTime() });
  events.push({ actor: '李京', action: 'commit.created', versionId: v1.id, message: '初始快照', reason: '首次接入版本管理' });

  // shanghai grows: two more files
  {
    const part = 'city=shanghai';
    const extra = serialize(makeOrders(rng(7), part, 6));
    writePageAtomic(part, 'part-002.ndjson', Buffer.from(extra, 'utf8'));
    ordersFiles[part]['part-002.ndjson'] = extra;
    const v = createVersion({ tableId: 'tbl_orders', kind: 'commit', label: '补充上海 6 笔订单', reason: '上游补数批次 B-1183', author: '陈数', changes: [{ partition: part, files: [{ path: 'part-002.ndjson', action: 'write' }] }], partitions: listPartitions('tbl_orders'), at: nextTime() });
    events.push({ actor: '陈数', action: 'commit.created', versionId: v.id, message: '补充上海 6 笔订单', reason: '上游补数批次 B-1183' });
  }

  // beijing amount fix on part-000
  {
    const part = 'city=beijing';
    const rows = JSON.parse(`[${ordersFiles[part]['part-000.ndjson'].trim().split('\n').join(',')}]`);
    const before = rows[0].amount;
    rows[0] = { ...rows[0], amount: Number((rows[0].amount * 1.4).toFixed(2)), status: 'settled', updated_at: '2026-11-16T12:00:00Z' };
    ordersFiles[part]['part-000.ndjson'] = serialize(rows);
    writePartition(part, ['part-000.ndjson'], ordersFiles[part]);
    const v = createVersion({ tableId: 'tbl_orders', kind: 'commit', label: '修正北京金额错误', reason: '工单 OPS-4471 金额被上游截断', author: '王点', changes: [{ partition: part, files: [{ path: 'part-000.ndjson', action: 'write' }] }], partitions: listPartitions('tbl_orders'), at: nextTime() });
    events.push({ actor: '王点', action: 'commit.created', versionId: v.id, message: `北京订单 ${rows[0].order_id} 金额 ${before} → ${rows[0].amount}`, reason: '数据修复' });
  }

  // hangzhou rewrite
  {
    const part = 'city=hangzhou';
    ordersFiles[part]['part-000.ndjson'] = serialize(makeOrders(rng(99), part, 10));
    writePartition(part, ['part-000.ndjson'], ordersFiles[part]);
    const v = createVersion({ tableId: 'tbl_orders', kind: 'commit', label: '杭州分区重算', reason: '渠道归因口径调整', author: '陈数', changes: [{ partition: part, files: [{ path: 'part-000.ndjson', action: 'write' }] }], partitions: listPartitions('tbl_orders'), at: nextTime() });
    events.push({ actor: '陈数', action: 'commit.created', versionId: v.id, message: '杭州分区重算', reason: '渠道归因口径调整' });
  }

  // chengdu deletes part-001 by mistake → this is the incident to roll back
  {
    const part = 'city=chengdu';
    const removed = ordersFiles[part]['part-001.ndjson'];
    delete ordersFiles[part]['part-001.ndjson'];
    fs.rmSync(path.join(getPagesDir(), part, 'part-001.ndjson'), { force: true });
    const v = createVersion({ tableId: 'tbl_orders', kind: 'commit', label: '清理成都空分区文件', reason: '误执行清理脚本', author: '王子', changes: [{ partition: part, files: [{ path: 'part-001.ndjson', action: 'delete' }] }], partitions: listPartitions('tbl_orders'), at: nextTime() });
    events.push({ actor: '王子', action: 'commit.created', versionId: v.id, message: '误删除成都 6 行订单', reason: '误执行清理脚本' });
    void removed;
  }

  // shipments versions
  {
    const v = createVersion({ tableId: 'tbl_shipments', kind: 'commit', label: '运单快照', reason: '接入版本管理', author: '王点', changes: [], partitions: listPartitions('tbl_shipments'), at: nextTime() });
    events.push({ actor: '王点', action: 'commit.created', versionId: v.id, message: '运单快照', reason: '接入版本管理' });
  }
  {
    const part = 'city=shanghai';
    const rows = JSON.parse(`[${ordersFiles[`ship:${part}`]['part-000.ndjson'].trim().split('\n').join(',')}]`);
    rows[2] = { ...rows[2], status: 'delivered', fee: 18.5 };
    ordersFiles[`ship:${part}`]['part-000.ndjson'] = serialize(rows);
    writePartition(part, ['part-000.ndjson'], ordersFiles[`ship:${part}`]);
    const v = createVersion({ tableId: 'tbl_shipments', kind: 'commit', label: '修正上海运单状态', reason: '承运商回传延迟', author: '王点', changes: [{ partition: part, files: [{ path: 'part-000.ndjson', action: 'write' }] }], partitions: listPartitions('tbl_shipments'), at: nextTime() });
    events.push({ actor: '王点', action: 'commit.created', versionId: v.id, message: '修正上海运单状态', reason: '承运商回传延迟' });
  }

  // An older restore on hangzhou that later got reverted, to make the timeline interesting
  {
    const partition = listPartitions('tbl_orders').find((p) => p.name === 'city=hangzhou');
    const target = getVersionBySeqSafe('tbl_orders', 3);
    if (target) {
      const jobId = 'job_demo_partial';
      const t = nextTime();
      db.prepare(
        `INSERT INTO restore_jobs (id, table_id, partition_id, target_version_id, target_version_seq, target_label, mode, state, phase, result, check_state,
          conflict_action, file_selection, selected_paths_json, operator, reason, ticket, baseline_version_id, baseline_seq, baseline_at, dry_run,
          progress_pct, total_bytes, processed_bytes, file_total, file_processed, conflict_count, message, last_heartbeat, created_at, updated_at, started_at, finished_at)
         VALUES (?, 'tbl_orders', ?, ?, ?, ?, 'version', 'completed', '完成', 'restored', 'passed', 'pause', 'all', '[]', ?, ?, ?, ?, ?, ?, 0, 100, 0, 0, 1, 1, 0, ?, ?, ?, ?, ?, ?)`,
      ).run(
        jobId,
        partition.id,
        target.id,
        target.seq,
        target.label,
        '陈数',
        '验证口径回退效果（演练）',
        'OPS-4240',
        target.id,
        target.seq,
        t,
        '演练恢复完成，无副作用',
        t,
        t,
        t,
        t,
      );
      events.push({ actor: '陈数', action: 'restore.completed', versionId: target.id, message: '演练恢复杭州分区', reason: '验证口径回退效果（演练）' });
    }
  }

  for (const event of events) {
    const version = getDb().prepare('SELECT * FROM versions WHERE id = ?').get(event.versionId);
    recordEvent({
      actor: event.actor,
      action: event.action,
      entityType: 'version',
      entityId: event.versionId,
      tableId: version?.table_id ?? 'tbl_orders',
      versionId: event.versionId,
      reason: event.reason,
      evidence: event.message,
      snapshot: version ? { seq: version.seq, snapshotHash: version.snapshot_hash, label: version.label } : null,
      at: version?.created_at ?? nowIso(),
    });
  }

  recordEvent({
    actor: '系统',
    action: 'system.seeded',
    entityType: 'system',
    entityId: 'seed',
    reason: '初始化演示数据',
    evidence: null,
    snapshot: { tables: 2, seededAt: nowIso() },
  });

  setMeta('seeded', nowIso());
  setMeta('seeded_at', nowIso());
  return {
    seeded: true,
    tables: listTablesLite(),
  };
}

function serialize(rows) {
  return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

function getVersionBySeqSafe(tableId, seq) {
  return getDb().prepare('SELECT * FROM versions WHERE table_id = ? AND seq = ?').get(tableId, seq) ?? null;
}

function listTablesLite() {
  return getDb().prepare('SELECT id, name FROM tables').all().map((r) => ({ id: r.id, name: r.name }));
}

export function corruptObjectForDemo({ tableId = 'tbl_orders', partition = 'city=chengdu', versionSeq } = {}) {
  const version = versionSeq
    ? getDb().prepare('SELECT * FROM versions WHERE table_id = ? AND seq = ?').get(tableId, versionSeq)
    : getDb().prepare('SELECT * FROM versions WHERE table_id = ? ORDER BY seq ASC LIMIT 1 OFFSET 3').get(tableId);
  if (!version) return { ok: false, reason: 'no_version' };
  const manifest = JSON.parse(version.manifest_json).filter((f) => f.partition === partition);
  if (!manifest.length) return { ok: false, reason: 'no_files' };
  const target = manifest[manifest.length - 1];
  const { objectPath } = objectStorePaths();
  const file = objectPath(target.checksum);
  if (!fs.existsSync(file)) return { ok: false, reason: 'object_missing' };
  fs.writeFileSync(file, 'CORRUPTED-BY-DEMO\n');
  return { ok: true, path: file, checksum: target.checksum, versionSeq: version.seq, file: target.path };
}

function objectStorePaths() {
  // local import avoids a cycle in tests that stub storage
  const objectsDir = path.join(getDataDir(), 'objects');
  return {
    objectPath: (checksum) => path.join(objectsDir, checksum.slice(0, 2), checksum),
  };
}
