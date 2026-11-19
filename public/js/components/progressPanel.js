import { h } from '../dom.js';
import { fmtBytes, fmtNum, shortHash, STATE_LABELS, STATE_TONE, CONFLICT_LABELS } from '../format.js';

const PHASES = [
  { key: 'checking', label: '完整性校验' },
  { key: 'running', label: '写入文件' },
  { key: 'verifying', label: '回读校验' },
  { key: 'finalizing', label: '提交版本' },
];

const PHASE_INDEX = { queued: 0, checking: 0, running: 1, conflict: 1, paused: 1, verifying: 2, finalizing: 3, completed: 4, failed: 4, cancelled: 4 };

export async function renderProgressPanel({ job, files = [], state, onAction, onRefresh }) {
  const card = h('div', { class: 'card' });
  card.appendChild(
    h(
      'div',
      { class: 'card-head' },
      h('h2', {}, '恢复进度'),
      h('span', { class: 'spacer' }),
      h('span', { class: `badge ${STATE_TONE[job.state] ?? ''}` }, STATE_LABELS[job.state] ?? job.state),
    ),
  );
  const body = h('div', { class: 'card-body stack' });

  const failed = job.state === 'failed';
  const warnTone = job.state === 'conflict';
  const fillClass = job.state === 'completed' ? 'done' : failed ? 'bad' : warnTone ? 'warn' : '';
  body.appendChild(
    h(
      'div',
      { class: 'stack', style: { gap: '6px' } },
      h(
        'div',
        { class: 'inline between', style: { fontSize: '12px' } },
        h('span', { class: 'muted' }, job.phase || '—'),
        h('span', { class: 'mono' }, `${job.progressPct}%`),
      ),
      h('div', { class: 'progress-bar', role: 'progressbar', 'aria-valuenow': job.progressPct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { class: `progress-fill ${fillClass}`, style: { width: `${job.progressPct}%` } })),
      h(
        'div',
        { class: 'inline between', style: { fontSize: '11.5px' } },
        h('span', { class: 'faint' }, `${job.fileProcessed} / ${job.fileTotal} 文件`),
        h('span', { class: 'faint' }, `${fmtBytes(job.processedBytes)} / ${fmtBytes(job.totalBytes)}`),
      ),
    ),
  );

  // Phase track
  const idx = PHASE_INDEX[job.state] ?? 0;
  const track = h('div', { class: 'phase-track' });
  PHASES.forEach((phase, i) => {
    const cls = i < idx ? 'done' : i === idx && job.state !== 'completed' ? 'active' : job.state === 'completed' ? 'done' : '';
    track.appendChild(h('div', { class: `phase-step ${cls}` }, h('div', { class: 'bar' }), h('span', {}, phase.label)));
  });
  body.appendChild(track);

  if (job.message) {
    const tone = failed ? 'bad' : job.state === 'conflict' ? 'warn' : job.state === 'completed' ? 'ok' : '';
    body.appendChild(h('div', { class: `callout ${tone}` }, job.message));
  }

  // Target + operator
  body.appendChild(
    h(
      'div',
      { class: 'stack', style: { gap: '7px', fontSize: '12px' } },
      row('目标版本', job.targetVersionSeq ? `v${job.targetVersionSeq}` : '—'),
      row('恢复方式', job.dryRun ? '演练（Dry Run）' : '实际写入'),
      row('操作者', job.operator),
      row('依据', job.reason || '—'),
      job.ticket ? row('工单', job.ticket) : null,
      row('任务', h('a', { href: `#/jobs/${job.id}` }, shortHash(job.id, 14))),
      job.baselineSeq ? row('恢复前版本', `v${job.baselineSeq}`) : null,
      job.newVersionId ? row('生成版本', h('a', { href: `#/jobs/${job.id}` }, shortHash(job.newVersionId, 12))) : null,
    ),
  );

  if (job.conflicts?.length) {
    body.appendChild(
      h(
        'div',
        { class: `callout ${job.state === 'conflict' ? 'warn' : ''}` },
        h('strong', {}, `冲突文件 ${job.conflicts.length} 个`),
        h(
          'div',
          { class: 'mt-1', style: { fontSize: '11.5px' } },
          ...job.conflicts.map((c) => h('div', { class: 'mono' }, `${c.path} · ${CONFLICT_LABELS[c.reason] ?? c.reason} · ${c.status}`)),
        ),
      ),
    );
  }

  if (job.integrity) {
    const integrity = job.integrity;
    if (integrity.damaged?.length) {
      body.appendChild(
        h(
          'div',
          { class: 'callout bad' },
          h('strong', {}, '完整性校验未通过'),
          h(
            'div',
            { class: 'mt-1', style: { fontSize: '11.5px' } },
            ...integrity.damaged.map((d) => h('div', { class: 'mono' }, `${d.path}: ${d.reason}`)),
          ),
        ),
      );
    } else if (integrity.checked !== undefined) {
      body.appendChild(h('div', { class: 'callout ok' }, `完整性校验通过：${integrity.checked} 个对象哈希一致`));
    }
  }

  if (job.error?.rollback) {
    body.appendChild(
      h(
        'div',
        { class: 'callout warn' },
        h('strong', {}, job.error.rollback.ok ? '已回滚到恢复前状态' : '回滚存在失败文件'),
        h('div', { class: 'hint mt-1' }, `${(job.error.rollback.files ?? []).filter((f) => f.restored !== 'failed').length} 个文件已还原`),
      ),
    );
  }

  const actions = h('div', { class: 'inline gap-1' });
  if (job.state === 'conflict') {
    actions.appendChild(h('button', { class: 'btn btn-warn btn-sm', onClick: () => onAction('resolve') }, '处理冲突…'));
  }
  if (job.state === 'paused') {
    actions.appendChild(h('button', { class: 'btn btn-primary btn-sm', onClick: () => onAction('resume') }, '恢复执行'));
  }
  if (!['completed', 'failed', 'cancelled'].includes(job.state)) {
    actions.appendChild(h('button', { class: 'btn btn-danger btn-sm', onClick: () => onAction('cancel') }, '取消任务'));
  }
  if (['running', 'paused', 'conflict'].includes(job.state) && (job.fileProcessed > 0 || job.state !== 'conflict')) {
    actions.appendChild(h('button', { class: 'btn btn-sm', onClick: () => onAction('rollback') }, '手动回滚'));
  }
  if (actions.childElementCount) body.appendChild(actions);

  if (files.length) {
    body.appendChild(h('div', { class: 'divider' }));
    body.appendChild(h('div', { class: 'section-title' }, '文件清单'));
    const list = h('div', { style: { maxHeight: '240px', overflowY: 'auto' } });
    for (const file of files) {
      list.appendChild(
        h(
          'div',
          { class: 'inline between', style: { fontSize: '11.5px', padding: '4px 0', gap: '8px' } },
          h('span', { class: 'mono', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, file.path),
          h('span', { class: `badge ${fileBadge(file.status)}` }, fileLabel(file)),
        ),
      );
    }
    body.appendChild(list);
  }

  card.appendChild(body);
  return card;
}

function row(label, value) {
  return h('div', { class: 'inline between' }, h('span', { class: 'faint' }, label), h('span', {}, value));
}

function fileBadge(status) {
  return {
    pending: 'info',
    writing: 'info',
    written: 'ok',
    deleted: 'warn',
    skipped: '',
    kept: 'warn',
    conflict: 'warn',
    failed: 'bad',
    rolled_back: 'bad',
    cancelled: '',
  }[status] ?? '';
}

function fileLabel(file) {
  const base = {
    pending: '等待',
    writing: '写入中',
    written: '已写入',
    deleted: '已删除',
    skipped: '跳过',
    kept: '保留',
    conflict: '冲突',
    failed: '失败',
    rolled_back: '已回滚',
    cancelled: '已取消',
  }[file.status] ?? file.status;
  if (file.skipReason) return `${base} · ${file.skipReason}`;
  if (file.verifyState === 'verified') return `${base} ✓`;
  return base;
}

export { PHASES };
