import { h, clear } from '../dom.js';
import { get } from '../api.js';
import { fmtTime, shortHash, ACTION_LABELS } from '../format.js';
import { setCleanup } from '../main.js';

export async function renderAudit(root, route) {
  const tables = (await get('/api/tables')).tables ?? [];
  const tableFilter = route.query.tableId ?? '';
  const actionFilter = route.query.action ?? '';
  const verify = await get(`/api/audit/verify${tableFilter ? `?tableId=${tableFilter}` : ''}`);
  const data = await get(`/api/audit?limit=200${tableFilter ? `&tableId=${tableFilter}` : ''}`);

  root.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, '审计日志'), h('p', { class: 'sub' }, '只追加的审计事件链：每次恢复都保留原始版本、操作者与依据，并按哈希串联防篡改。')),
    ),
  );

  const statusCard = h('div', { class: `card`, style: { marginBottom: '18px' } });
  statusCard.appendChild(
    h(
      'div',
      { class: 'card-body inline between' },
      h(
        'div',
        { class: 'inline gap-1' },
        h('span', { class: `badge ${verify.ok ? 'ok' : 'bad'}` }, verify.ok ? '✓ 审计链完整' : '✗ 审计链被篡改'),
        h('span', { class: 'faint', style: { fontSize: '12px' } }, `已校验 ${verify.checked} 条事件`),
        verify.broken?.length ? h('span', { class: 'badge bad' }, `${verify.broken.length} 条异常`) : null,
      ),
      h(
        'div',
        { class: 'inline gap-1' },
        h(
          'select',
          {
            style: { width: '200px' },
            onChange: (e) => {
              const v = e.target.value;
              location.hash = `#/audit${v ? `?tableId=${v}` : ''}`;
            },
          },
          h('option', { value: '' }, '全部数据表'),
          ...tables.map((t) => h('option', { value: t.id, selected: t.id === tableFilter }, t.name)),
        ),
      ),
    ),
  );
  root.appendChild(statusCard);

  const card = h('div', { class: 'card' });
  card.appendChild(h('div', { class: 'card-head' }, h('h2', {}, `事件（${data.total}）`), h('span', { class: 'spacer' }), h('span', { class: 'hint' }, '最新在前')));
  const body = h('div', { class: 'card-body' });
  if (!data.events.length) {
    body.appendChild(h('div', { class: 'empty' }, '暂无审计事件'));
  }
  for (const event of data.events) {
    const tone = event.action.includes('failed') || event.action.includes('cancelled') || event.action.includes('corrupted') ? 'bad' : event.action.includes('conflict') ? 'warn' : event.action.includes('completed') ? 'ok' : 'info';
    body.appendChild(
      h(
        'div',
        { class: 'audit-item' },
        h('div', { class: 'audit-time' }, fmtTime(event.at, { seconds: true })),
        h('div', { class: 'audit-node' }, h('span', { class: 'n', style: { background: `var(--${tone === 'bad' ? 'danger' : tone === 'warn' ? 'warn' : tone === 'ok' ? 'ok' : 'accent'})` } }), h('span', { class: 'l' })),
        h(
          'div',
          { style: { minWidth: 0 } },
          h(
            'div',
            { class: 'audit-action' },
            h('span', {}, ACTION_LABELS[event.action] ?? event.action),
            h('span', { class: 'faint' }, event.actor),
            h('span', { class: 'badge' }, event.entityType),
            event.jobId ? h('a', { class: 'badge info', href: `#/jobs/${event.jobId}` }, '任务') : null,
          ),
          event.reason ? h('div', { class: 'audit-reason' }, event.reason) : null,
          event.evidence ? h('div', { class: 'audit-reason mono', style: { fontSize: '11px' } }, event.evidence) : null,
          h(
            'div',
            { class: 'audit-meta' },
            h('span', { class: 'hash-chain', title: `prev=${event.prevHash ?? 'null'}` }, `hash ${shortHash(event.hash, 14)}`),
            event.snapshot ? h('span', {}, '含快照') : null,
          ),
          event.snapshot ? h('details', { style: { marginTop: '5px' } }, h('summary', { class: 'hint', style: { cursor: 'pointer' } }, '查看操作凭证'), h('div', { class: 'snapshot-box' }, JSON.stringify(event.snapshot, null, 2))) : null,
        ),
      ),
    );
  }
  card.appendChild(body);
  root.appendChild(card);
  setCleanup(null);
}
