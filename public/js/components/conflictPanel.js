import { h } from '../dom.js';
import { shortHash, CONFLICT_LABELS } from '../format.js';

export function renderConflictPanel({ job, onResolve }) {
  const conflicts = job.conflicts ?? [];
  const card = h('div', { class: 'card', style: { borderColor: 'color-mix(in srgb, var(--warn) 45%, var(--line))' } });
  card.appendChild(
    h(
      'div',
      { class: 'card-head', style: { background: 'var(--warn-soft)' } },
      h('h2', { style: { color: 'var(--warn)' } }, '⚠ 并发写入冲突'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'badge warn' }, '已暂停'),
    ),
  );
  const body = h('div', { class: 'card-body stack' });
  body.appendChild(
    h('p', { class: 'muted', style: { fontSize: '12.5px' } }, `恢复开始后，以下 ${conflicts.length} 个文件被其他写入者修改。恢复已暂停，未覆盖任何冲突文件。请选择处理策略：`),
  );
  for (const c of conflicts) {
    body.appendChild(
      h(
        'div',
        { class: 'conflict-file' },
        h('span', { class: 'mono' }, c.path),
        h('span', { class: 'faint' }, CONFLICT_LABELS[c.reason] ?? c.reason),
        h('span', { class: 'hashpill', title: '当前文件' }, shortHash(c.liveChecksum, 8)),
        h('span', { class: 'hashpill', title: '目标版本' }, shortHash(c.targetChecksum, 8)),
      ),
    );
  }
  body.appendChild(h('button', { class: 'btn btn-warn btn-block', onClick: onResolve }, '选择处理方式…'));
  card.appendChild(body);
  return card;
}
