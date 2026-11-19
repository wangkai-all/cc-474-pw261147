import { h } from '../dom.js';
import { get } from '../api.js';
import { fmtNum, fmtTimeShort, relativeTime, STATE_LABELS, STATE_TONE } from '../format.js';
import { setCleanup } from '../main.js';

export async function renderTables(root, route) {
  const data = await get('/api/tables');
  const tables = data.tables ?? [];

  root.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, '数据表'),
        h('p', { class: 'sub' }, `${tables.length} 张受版本管理的数据表 · 选择一张表查看版本时间线、发起恢复`),
      ),
    ),
  );

  if (tables.length === 0) {
    root.appendChild(
      h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'big' }, '🗂'), h('p', {}, '还没有数据表'), h('p', { class: 'hint mt-1' }, '使用右上角“重置演示数据”生成示例'))),
    );
    return;
  }

  const grid = h('div', { class: 'table-grid' });
  for (const table of tables) {
    grid.appendChild(
      h(
        'a',
        { class: 'card table-card', href: `#/table/${table.id}` },
        h(
          'div',
          { class: 'inline between' },
          h('h3', {}, table.name, table.activeRestores > 0 ? h('span', { class: 'badge warn' }, '恢复中') : null),
          h('span', { class: 'badge mono' }, `${table.partitionKey}`),
        ),
        h('p', { class: 'desc' }, table.description || '无描述'),
        h(
          'div',
          { class: 'inline gap-1' },
          ...(table.downstream ?? []).slice(0, 3).map((d) => h('span', { class: 'badge', title: `${d.type} · ${d.owner}` }, d.name)),
          (table.downstream ?? []).length > 3 ? h('span', { class: 'badge' }, `+${table.downstream.length - 3}`) : null,
        ),
        h(
          'div',
          { class: 'stat-row' },
          h('div', { class: 'stat' }, h('span', { class: 'v' }, fmtNum(table.latestVersion?.seq ?? 0)), h('span', { class: 'k' }, '当前版本')),
          h('div', { class: 'stat' }, h('span', { class: 'v' }, fmtNum(table.partitionCount)), h('span', { class: 'k' }, '分区')),
          h('div', { class: 'stat' }, h('span', { class: 'v' }, fmtNum(table.latestVersion?.rowCount ?? 0)), h('span', { class: 'k' }, '行数')),
          h(
            'div',
            { class: 'stat', style: { marginLeft: 'auto', textAlign: 'right' } },
            h('span', { class: 'v', style: { fontSize: '12px', fontWeight: '500' } }, table.latestVersion ? relativeTime(table.latestVersion.createdAt) : '—'),
            h('span', { class: 'k' }, '最近变更'),
          ),
        ),
      ),
    );
  }
  root.appendChild(grid);

  // Recent restore activity across tables
  const jobs = (await get('/api/restores?limit=8')).jobs ?? [];
  if (jobs.length > 0) {
    root.appendChild(h('div', { class: 'section-title mt-3' }, '最近恢复任务'));
    const card = h('div', { class: 'card' }, h('div', { class: 'card-body flush' }));
    const list = h('div', {});
    for (const job of jobs) {
      list.appendChild(
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
              h('span', {}, `恢复至 v${job.targetVersionSeq}`),
              h('span', { class: `badge ${STATE_TONE[job.state] ?? ''}` }, STATE_LABELS[job.state] ?? job.state),
              job.result === 'noop' ? h('span', { class: 'badge' }, '幂等跳过') : null,
            ),
            h('div', { class: 'js' }, `${job.operator} · ${job.reason} · ${fmtTimeShort(job.createdAt)}`),
          ),
          h('span', { class: 'faint mono nowrap' }, `${job.progressPct}%`),
        ),
      );
    }
    card.querySelector('.card-body').appendChild(list);
    root.appendChild(card);
  }
  setCleanup(null);
}
