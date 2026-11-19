import { h, clear } from '../dom.js';
import { get } from '../api.js';
import { fmtNum, fmtTime, shortHash, STATE_LABELS, STATE_TONE } from '../format.js';
import { setCleanup } from '../main.js';

export async function renderJobs(root, route) {
  const data = await get('/api/restores?limit=60');
  const jobs = data.jobs ?? [];
  const tables = (await get('/api/tables')).tables ?? [];
  const tableName = new Map(tables.map((t) => [t.id, t.name]));

  root.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, '恢复任务'), h('p', { class: 'sub' }, '全部恢复任务的执行状态、冲突与结果。点击查看详情。')),
    ),
  );

  if (route.id) {
    const job = jobs.find((j) => j.id === route.id) ?? (await get(`/api/restores/${route.id}`)).job;
    root.appendChild(await renderJobDetail(job, job ? tableName.get(job.tableId) : null));
    return;
  }

  const card = h('div', { class: 'card' });
  card.appendChild(h('div', { class: 'card-head' }, h('h2', {}, `共 ${jobs.length} 个任务`)));
  if (!jobs.length) {
    card.appendChild(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🧾'), h('p', {}, '还没有恢复任务'), h('p', { class: 'hint mt-1' }, '在数据表页面选择版本后点击“恢复分区”')));
  } else {
    const body = h('div', { class: 'card-body flush' });
    for (const job of jobs) {
      body.appendChild(
        h(
          'a',
          { class: 'job-item', href: `#/jobs/${job.id}` },
          h('span', { class: `job-state-dot ${job.state}` }),
          h(
            'div',
            { class: 'jm' },
            h(
              'div',
              { class: 'jt' },
              h('span', {}, `${tableName.get(job.tableId) ?? job.tableId} → v${job.targetVersionSeq ?? '?'}`),
              h('span', { class: `badge ${STATE_TONE[job.state] ?? ''}` }, STATE_LABELS[job.state] ?? job.state),
              job.result === 'noop' ? h('span', { class: 'badge' }, '幂等') : null,
              job.dryRun ? h('span', { class: 'badge violet' }, '演练') : null,
              job.conflictCount ? h('span', { class: 'badge warn' }, `${job.conflictCount} 冲突`) : null,
            ),
            h('div', { class: 'js' }, `${job.operator} · ${job.reason} · ${fmtTime(job.createdAt)}`),
          ),
          h(
            'div',
            { class: 'right', style: { minWidth: '90px' } },
            h('div', { class: 'mono', style: { fontSize: '12px' } }, `${job.progressPct}%`),
            h('div', { class: 'hint' }, `${job.fileProcessed}/${job.fileTotal} 文件`),
          ),
        ),
      );
    }
    card.appendChild(body);
  }
  root.appendChild(card);
}

async function renderJobDetail(job, tableName) {
  const { files } = await get(`/api/restores/${job.id}`);
  const audit = await get(`/api/audit?jobId=${job.id}&limit=200`);
  const wrap = h('div', { class: 'stack' });
  wrap.appendChild(
    h(
      'div',
      { class: 'crumbs' },
      h('a', { href: '#/jobs' }, '恢复任务'),
      h('span', {}, '/'),
      h('span', { class: 'mono' }, shortHash(job.id, 16)),
    ),
  );
  wrap.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', { class: 'inline gap-1' }, `恢复到 v${job.targetVersionSeq}`, h('span', { class: `badge ${STATE_TONE[job.state] ?? ''}` }, STATE_LABELS[job.state] ?? job.state)),
        h('p', { class: 'sub' }, `${tableName ?? job.tableId} · ${job.operator} · ${fmtTime(job.createdAt, { seconds: true })}`),
      ),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: `#/table/${job.tableId}?job=${job.id}&partition=${encodeURIComponent(job.diff?.partition ?? '')}` }, '在数据表中查看'),
    ),
  );

  const grid = h('div', { class: 'grid cols-2' });
  const left = h('div', { class: 'stack' });
  const right = h('div', { class: 'stack' });

  // Summary card
  const info = h('div', { class: 'card' });
  info.appendChild(h('div', { class: 'card-head' }, h('h2', {}, '任务信息')));
  const infoBody = h('div', { class: 'card-body stack' });
  infoBody.appendChild(
    h('div', { class: 'progress-bar', style: { height: '10px' } }, h('div', { class: `progress-fill ${job.state === 'completed' ? 'done' : job.state === 'failed' ? 'bad' : 'warn'}`, style: { width: `${job.progressPct}%` } })),
  );
  const rows = [
    ['状态', `${STATE_LABELS[job.state] ?? job.state} · ${job.phase}`],
    ['结果', job.result || '—'],
    ['分区', job.diff?.partition ?? '—'],
    ['目标版本', `v${job.targetVersionSeq} · ${job.targetLabel || ''}`],
    ['恢复前版本', job.baselineSeq ? `v${job.baselineSeq}` : '—'],
    ['文件进度', `${job.fileProcessed} / ${job.fileTotal}`],
    ['操作者', job.operator],
    ['依据', job.reason],
    ['工单', job.ticket || '—'],
    ['创建', fmtTime(job.createdAt, { seconds: true })],
    ['完成', job.finishedAt ? fmtTime(job.finishedAt, { seconds: true }) : '—'],
    ['生成版本', job.newVersionId ? shortHash(job.newVersionId, 14) : '—'],
    ['已回滚', job.reverted ? '是' : '否'],
  ];
  for (const [k, v] of rows) {
    infoBody.appendChild(h('div', { class: 'inline between', style: { fontSize: '12.5px' } }, h('span', { class: 'faint' }, k), h('span', { class: 'mono', style: { fontSize: '12px' } }, String(v))));
  }
  if (job.message) infoBody.appendChild(h('div', { class: 'callout' }, job.message));
  info.appendChild(infoBody);
  left.appendChild(info);

  // Files
  const filesCard = h('div', { class: 'card' });
  filesCard.appendChild(h('div', { class: 'card-head' }, h('h2', {}, `文件明细 (${files.length})`)));
  const fbody = h('div', { class: 'card-body flush' });
  const table = h(
    'table',
    { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, '文件'), h('th', {}, '状态'), h('th', {}, '基线'), h('th', {}, '目标'), h('th', {}, '校验'))),
    h(
      'tbody',
      {},
      ...files.map((f) =>
        h(
          'tr',
          {},
          h('td', { class: 'mono' }, f.path),
          h('td', {}, h('span', { class: `badge ${f.status === 'written' ? 'ok' : f.status === 'conflict' ? 'warn' : f.status === 'failed' ? 'bad' : ''}` }, f.status), f.skipReason ? h('div', { class: 'hint' }, f.skipReason) : null),
          h('td', { class: 'mono faint' }, shortHash(f.baselineChecksum, 8)),
          h('td', { class: 'mono faint' }, shortHash(f.targetChecksum, 8)),
          h('td', {}, f.verifyState),
        ),
      ),
    ),
  );
  fbody.appendChild(h('div', { class: 'scroll-x' }, table));
  filesCard.appendChild(fbody);
  left.appendChild(filesCard);

  // Audit trail for this job
  const auditCard = h('div', { class: 'card' });
  auditCard.appendChild(h('div', { class: 'card-head' }, h('h2', {}, '任务审计链'), h('span', { class: 'spacer' }), h('span', { class: 'badge mono' }, `${audit.total} 条`)));
  const abody = h('div', { class: 'card-body' });
  for (const event of [...audit.events].reverse()) {
    abody.appendChild(renderAuditRow(event));
  }
  auditCard.appendChild(abody);
  right.appendChild(auditCard);

  if (job.diff) {
    const diffCard = h('div', { class: 'card' });
    diffCard.appendChild(h('div', { class: 'card-head' }, h('h2', {}, '恢复时计算的差异')));
    const dbody = h('div', { class: 'card-body' });
    const s = job.diff.summary;
    dbody.appendChild(
      h(
        'div',
        { class: 'diff-summary' },
        h('div', { class: 'chip-stat add' }, h('span', { class: 'v' }, s.added), h('span', { class: 'k' }, '新增')),
        h('div', { class: 'chip-stat mod' }, h('span', { class: 'v' }, s.modified), h('span', { class: 'k' }, '修改')),
        h('div', { class: 'chip-stat del' }, h('span', { class: 'v' }, s.removed), h('span', { class: 'k' }, '删除')),
        h('div', { class: 'chip-stat' }, h('span', { class: 'v' }, fmtNum(s.rowsAdded)), h('span', { class: 'k' }, '新增行')),
        h('div', { class: 'chip-stat' }, h('span', { class: 'v' }, fmtNum(s.rowsRemoved)), h('span', { class: 'k' }, '删除行')),
      ),
    );
    dbody.appendChild(h('div', { class: 'hint mt-1' }, '完整差异请回到数据表页面查看。'));
    diffCard.appendChild(dbody);
    right.appendChild(diffCard);
  }

  grid.appendChild(left);
  grid.appendChild(right);
  wrap.appendChild(grid);
  return wrap;
}

function renderAuditRow(event) {
  return h(
    'div',
    { class: 'audit-item' },
    h('div', { class: 'audit-time' }, fmtTime(event.at, { seconds: true })),
    h('div', { class: 'audit-node' }, h('span', { class: 'n' }), h('span', { class: 'l' })),
    h(
      'div',
      {},
      h('div', { class: 'audit-action' }, h('span', {}, labelOf(event.action)), h('span', { class: 'badge mono' }, event.action), h('span', { class: 'faint' }, event.actor)),
      event.reason ? h('div', { class: 'audit-reason' }, event.reason) : null,
      h('div', { class: 'audit-meta' }, h('span', { class: 'hash-chain', title: event.hash }, `hash ${shortHash(event.hash, 12)}`), event.evidence ? h('span', {}, event.evidence) : null),
    ),
  );
}

function labelOf(action) {
  const map = {
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
  };
  return map[action] ?? action;
}
