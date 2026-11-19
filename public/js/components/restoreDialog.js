import { h, clear } from '../dom.js';
import { post } from '../api.js';
import { bad, info, closeModal, openModal } from '../ui.js';
import { fmtNum, shortHash } from '../format.js';

/**
 * Create-restore dialog. Supports restoring by point-in-time, by version
 * sequence / id, or by label; shows the preflight diff + downstream impact
 * before committing, and explains the concurrent-write policy.
 */
export function restoreDialog({ table, partition, versions, version, onCreated }) {
  const partitionFiles = version?.manifest?.filter((f) => f.partition === partition) ?? [];
  const latest = versions[0];
  const targetRef = version ?? latest;

  const modeSeg = h('div', { class: 'segmented', role: 'tablist' });
  const modes = [
    { key: 'version', label: '按版本' },
    { key: 'point', label: '按时间点' },
  ];
  let mode = version ? 'version' : 'version';

  const operator = h('input', { type: 'text', placeholder: '例如 李京', autocomplete: 'name' });
  const reason = h('textarea', { placeholder: '说明为什么要恢复（至少 4 个字符，写入审计）' });
  const ticket = h('input', { type: 'text', placeholder: '可选，如 OPS-5001' });
  const dryRun = h('input', { type: 'checkbox' });
  const conflictAction = h(
    'select',
    {},
    h('option', { value: 'pause', selected: true }, '暂停并让我选择（推荐）'),
    h('option', { value: 'keep_current' }, '保留当前文件'),
    h('option', { value: 'overwrite_target' }, '覆盖为恢复目标'),
    h('option', { value: 'abort' }, '发现冲突即中止'),
  );

  const versionSelect = h(
    'select',
    {},
    ...versions.map((v) =>
      h('option', { value: v.id, selected: v.id === targetRef?.id }, `v${v.seq} · ${v.label || '提交'} · ${v.author} · ${new Date(v.createdAt).toLocaleString('zh-CN')}`),
    ),
  );

  const timeInput = h('input', { type: 'datetime-local', value: toLocalInput(new Date(targetRef?.createdAt ?? Date.now())) });
  const resolvedNote = h('div', { class: 'callout', style: { fontSize: '12px' } });

  const body = h('div', { class: 'stack' });
  const modeWrap = h('div', {});
  const versionWrap = h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', {}, '目标版本'), versionSelect));
  const timeWrap = h('div', { class: 'stack', style: { display: 'none' } }, h('label', { class: 'field' }, h('span', {}, '目标时间点（选择该时间及之前最近的版本）'), timeInput), resolvedNote);

  function setMode(next) {
    mode = next;
    [...modeSeg.children].forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
    versionWrap.style.display = next === 'version' ? '' : 'none';
    timeWrap.style.display = next === 'point' ? '' : 'none';
    if (next === 'point') resolvePoint();
  }

  for (const m of modes) {
    modeSeg.appendChild(
      h('button', { 'data-mode': m.key, class: m.key === mode ? 'active' : '', onClick: () => setMode(m.key) }, m.label),
    );
  }

  let resolvedSeq = targetRef?.seq ?? null;
  async function resolvePoint() {
    clear(resolvedNote);
    resolvedNote.appendChild(h('span', { class: 'faint' }, '正在解析时间点…'));
    try {
      const res = await fetch(`/api/tables/${table.id}/resolve?at=${encodeURIComponent(new Date(timeInput.value).toISOString())}`).then((r) => r.json());
      if (res.version) {
        resolvedSeq = res.version.seq;
        clear(resolvedNote);
        resolvedNote.appendChild(
          h('span', {}, `将恢复到 `, h('b', {}, `v${res.version.seq}`), ` · ${res.version.label || '提交'} · ${new Date(res.version.createdAt).toLocaleString('zh-CN')} · ${res.version.author}`),
        );
      } else {
        resolvedNote.appendChild(h('span', { style: { color: 'var(--danger)' } }, '该时间点之前没有版本'));
      }
    } catch {
      clear(resolvedNote);
      resolvedNote.appendChild(h('span', { style: { color: 'var(--danger)' } }, '解析失败'));
    }
  }
  timeInput.addEventListener('change', resolvePoint);

  // Preflight summary
  const preflight = h('div', { class: 'callout', style: { fontSize: '12px' } }, '正在计算预检差异…');
  post(`/api/tables/${table.id}/diff`, { partition, versionId: targetRef?.id })
    .then(({ diff, impact }) => {
      clear(preflight);
      preflight.appendChild(
        h(
          'div',
          { class: 'inline gap-1', style: { flexWrap: 'wrap' } },
          h('span', { class: 'badge ok' }, `+${diff.summary.added} 文件`),
          h('span', { class: 'badge warn' }, `~${diff.summary.modified} 修改`),
          h('span', { class: 'badge bad' }, `-${diff.summary.removed} 删除`),
          h('span', { class: 'badge' }, `${fmtNum(diff.summary.rowsAdded + diff.summary.rowsRemoved + diff.summary.rowsChanged)} 行变化`),
          h('span', { class: 'badge info' }, `${impact.downstreamCount} 个下游`),
          diff.damagedFileCount ? h('span', { class: 'badge bad' }, `${diff.damagedFileCount} 个损坏文件`) : null,
        ),
      );
      preflight.appendChild(h('div', { class: 'hint mt-1' }, `目标分区 ${partition} · 将影响 ${diff.summary.changedFiles} 个文件，涉及下游 ${impact.downstreamCount} 个任务`));
      if (diff.damagedFileCount) {
        preflight.appendChild(h('div', { class: 'mt-1', style: { color: 'var(--danger)' } }, '⚠ 目标版本存在损坏对象，恢复会在完整性校验阶段被阻断。'));
      }
    })
    .catch(() => {
      clear(preflight);
      preflight.textContent = '预检失败，仍可提交（服务端会重新计算）。';
    });

  body.appendChild(modeSeg);
  body.appendChild(versionWrap);
  body.appendChild(timeWrap);
  body.appendChild(h('div', { class: 'section-title mt-1', style: { marginBottom: 0 } }, '预检'));
  body.appendChild(preflight);
  body.appendChild(h('div', { class: 'divider' }));
  body.appendChild(h('div', { class: 'section-title' }, '审计信息'));
  body.appendChild(
    h(
      'div',
      { class: 'grid cols-2' },
      h('label', { class: 'field' }, h('span', {}, '操作者 ', h('span', { class: 'req' }, '*')), operator),
      h('label', { class: 'field' }, h('span', {}, '关联工单'), ticket),
    ),
  );
  body.appendChild(h('label', { class: 'field' }, h('span', {}, '恢复依据 ', h('span', { class: 'req' }, '*')), reason));
  body.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', {}, '并发写入检测策略'),
      conflictAction,
      h('span', { class: 'hint' }, '恢复开始时以及每个文件写入前都会对比基线；发现并发修改时按此策略处理。“暂停”会把任务停住等待你选择。'),
    ),
  );
  body.appendChild(
    h(
      'label',
      { class: 'inline gap-1', style: { fontSize: '12.5px', color: 'var(--text-dim)' } },
      dryRun,
      h('span', {}, '演练模式（仅计算差异与影响，不写入任何文件）'),
    ),
  );

  const footer = [
    h('button', { class: 'btn btn-ghost', onClick: () => closeModal() }, '取消'),
    h(
      'button',
      {
        class: 'btn btn-primary',
        onClick: async (e) => {
          try {
            e.target.disabled = true;
            if (!operator.value.trim()) throw new Error('请填写操作者');
            if (reason.value.trim().length < 4) throw new Error('恢复依据至少 4 个字符');
            const payload = {
              tableId: table.id,
              partition,
              operator: operator.value.trim(),
              reason: reason.value.trim(),
              ticket: ticket.value.trim(),
              mode,
              dryRun: dryRun.checked,
              conflictAction: conflictAction.value,
            };
            if (mode === 'point') {
              payload.at = new Date(timeInput.value).toISOString();
              payload.mode = 'point';
            } else {
              payload.versionId = versionSelect.value;
            }
            const res = await post('/api/restores', payload);
            closeModal();
            onCreated(res.job);
          } catch (err) {
            bad('创建恢复任务失败', err.message);
            e.target.disabled = false;
          }
        },
      },
      '创建恢复任务',
    ),
  ];

  openModal({ title: `恢复分区 ${partition}`, body, footer, wide: true });
  setMode(mode);
  operator.focus();
}

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
