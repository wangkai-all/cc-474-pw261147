export function fmtTime(iso, { seconds = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
  return `${date} ${time}`;
}

export function fmtTimeShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const units = [
    [86400000, '天'],
    [3600000, '小时'],
    [60000, '分钟'],
    [1000, '秒'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const value = Math.floor(abs / ms);
      return diff >= 0 ? `${value} ${label}前` : `${value} ${label}后`;
    }
  }
  return '刚刚';
}

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('zh-CN');
}

export function fmtDelta(n) {
  if (n === 0) return '0';
  return n > 0 ? `+${fmtNum(n)}` : fmtNum(n);
}

export function shortHash(hash, len = 8) {
  if (!hash) return '—';
  return hash.slice(0, len);
}

export function toLocalInputValue(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const STATE_LABELS = {
  queued: '排队中',
  checking: '完整性校验',
  running: '写入中',
  conflict: '冲突暂停',
  paused: '已暂停',
  verifying: '回读校验',
  finalizing: '提交版本',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const STATE_TONE = {
  queued: 'info',
  checking: 'info',
  running: 'info',
  conflict: 'warn',
  paused: 'warn',
  verifying: 'info',
  finalizing: 'info',
  completed: 'ok',
  failed: 'bad',
  cancelled: 'bad',
};

export const ACTION_LABELS = {
  'commit.created': '提交新版本',
  'restore.requested': '发起恢复',
  'restore.completed': '恢复完成',
  'restore.noop': '恢复（无变更）',
  'restore.failed': '恢复失败',
  'restore.cancelled': '取消恢复',
  'restore.resumed': '恢复执行',
  'restore.conflict_detected': '检测到冲突',
  'restore.conflict_decision': '冲突决策',
  'restore.conflict_resolved': '冲突处理',
  'restore.rollback_requested': '手动回滚',
  'restore.integrity_failed': '完整性校验失败',
  'system.seeded': '初始化数据',
  'system.object_corrupted': '故障演练',
};

export const CONFLICT_LABELS = {
  concurrent_write: '并发写入',
  concurrent_delete: '并发删除',
};

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
