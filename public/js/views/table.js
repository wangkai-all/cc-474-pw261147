import { h, clear } from '../dom.js';
import { get, post } from '../api.js';
import { ok, info, warn, bad, openModal, closeModal } from '../ui.js';
import {
  fmtBytes,
  fmtDelta,
  fmtNum,
  fmtTime,
  fmtTimeShort,
  relativeTime,
  shortHash,
  toLocalInputValue,
  STATE_LABELS,
  STATE_TONE,
  ACTION_LABELS,
  CONFLICT_LABELS,
} from '../format.js';
import { setCleanup } from '../main.js';
import { restoreDialog } from '../components/restoreDialog.js';
import { renderDiffPanel } from '../components/diffPanel.js';
import { renderProgressPanel } from '../components/progressPanel.js';
import { renderConflictPanel } from '../components/conflictPanel.js';

export async function renderTable(root, route) {
  const state = {
    tableId: route.tableId,
    partition: route.partition,
    selectedVersionId: route.version,
    comparison: route.query.compare === 'version' ? 'version' : 'live',
    compareVersionId: route.query.compareVersion ?? null,
    tab: route.query.tab ?? 'timeline',
    jobId: route.job ?? route.query.job ?? null,
    pollTimer: null,
    destroyed: false,
  };

  const loadTable = async () => {
    const data = await get(`/api/tables/${state.tableId}`);
    return data;
  };

  let data = await loadTable();
  if (!state.partition) state.partition = data.partitions[0]?.name ?? null;
  if (!state.selectedVersionId) state.selectedVersionId = data.versions[0]?.id ?? null;

  const container = h('div', {});
  root.appendChild(container);

  const renderAll = async ({ preserveScroll = false } = {}) => {
    if (state.destroyed) return;
    const scrollY = preserveScroll ? window.scrollY : null;
    const fresh = await loadTable();
    data = fresh;
    if (state.jobId) {
      try {
        const jobData = await get(`/api/restores/${state.jobId}`);
        state.job = jobData.job;
        state.jobFiles = jobData.files;
      } catch {
        state.job = null;
      }
    }
    const selectedVersion = data.versions.find((v) => v.id === state.selectedVersionId) ?? data.versions[0] ?? null;
    if (selectedVersion) state.selectedVersionId = selectedVersion.id;

    clear(container);
    container.appendChild(renderHeader(data.table, state, data, () => openRestore(selectedVersion)));
    container.appendChild(renderPartitionBar(data, state, () => renderAll()));

    const grid = h('div', { class: 'grid sidebar' });
    const left = h('div', { class: 'stack' });
    const right = h('div', { class: 'stack' });

    left.appendChild(renderTimeline(data, state, () => renderAll()));

    if (selectedVersion) {
      left.appendChild(await renderDiffPanel({
        table: data.table,
        partition: state.partition,
        version: selectedVersion,
        versions: data.versions,
        comparison: state.comparison,
        compareVersionId: state.compareVersionId,
        onChange: (patch) => {
          Object.assign(state, patch);
          renderAll();
        },
        onRestore: () => openRestore(selectedVersion),
      }));
    }

    if (state.job) {
      if (state.job.state === 'conflict') {
        right.appendChild(renderConflictPanel({ job: state.job, onResolve: () => onJobAction('resolve') }));
      }
      right.appendChild(await renderProgressPanel({ job: state.job, files: state.jobFiles, state, onAction: onJobAction, onRefresh: renderAll }));
    }
    right.appendChild(renderLocksPanel(data));
    right.appendChild(renderVersionsMeta(data, state));
    right.appendChild(renderLiveFiles(data, state));

    grid.appendChild(left);
    grid.appendChild(right);
    container.appendChild(grid);

    if (scrollY !== null) window.scrollTo(0, scrollY);
    startPolling();
  };

  const openRestore = (version) => {
    restoreDialog({
      table: data.table,
      partition: state.partition,
      versions: data.versions,
      version,
      onCreated: (job) => {
        state.jobId = job.id;
        state.job = job;
        info('恢复任务已创建', job.dryRun ? '演练模式不会写入文件' : '进度可在右侧实时查看');
        renderAll();
      },
    });
  };

  const onJobAction = async (action) => {
    if (!state.job) return;
    try {
      if (action === 'resolve') {
        const refreshed = await get(`/api/restores/${state.jobId}`);
        state.job = refreshed.job;
        state.jobFiles = refreshed.files;
        openConflictModal(state.job, async () => {
          const r = await get(`/api/restores/${state.jobId}`);
          state.job = r.job;
          if (['completed', 'failed', 'cancelled'].includes(r.job.state)) state.jobId = r.job.id;
          renderAll();
        });
        return;
      }
      if (action === 'cancel') {
        openCancelModal(state.job, async () => {
          renderAll();
        });
        return;
      }
      if (action === 'rollback') {
        openRollbackModal(state.job, async () => renderAll());
        return;
      }
      if (action === 'resume') {
        await post(`/api/restores/${state.jobId}/resume`, { operator: '当前操作者', reason: '恢复中断任务继续执行' });
        ok('任务已恢复');
        renderAll();
      }
    } catch (err) {
      bad('操作失败', err.message);
    }
  };

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.destroyed) return;
    state.pollTimer = setInterval(async () => {
      if (state.destroyed) return;
      const active = state.job && !['completed', 'failed', 'cancelled'].includes(state.job.state);
      if (!active) {
        const tableHasActive = (data?.partitions ?? []).some((p) => p.lock);
        if (!tableHasActive) return;
      }
      try {
        const freshJob = state.jobId ? await get(`/api/restores/${state.jobId}`) : null;
        const freshTable = await loadTable();
        if (state.destroyed) return;
        data = freshTable;
        if (freshJob) {
          const before = state.job?.state;
          state.job = freshJob.job;
          state.jobFiles = freshJob.files;
          if (before && before !== freshJob.job.state && ['completed', 'failed', 'cancelled'].includes(freshJob.job.state)) {
            if (freshJob.job.state === 'completed') ok('恢复完成', freshJob.job.message);
            else if (freshJob.job.state === 'failed') bad('恢复失败', freshJob.job.message);
            else warn('恢复已取消', freshJob.job.message);
          }
        }
        await renderAll({ preserveScroll: true });
      } catch (err) {
        console.error(err);
      }
    }, 1200);
  }

  setCleanup(() => {
    state.destroyed = true;
    if (state.pollTimer) clearInterval(state.pollTimer);
  });

  window.addEventListener(
    'beforeunload',
    () => {
      if (state.pollTimer) clearInterval(state.pollTimer);
    },
    { once: true },
  );

  await renderAll();
}

/* ------------------------------------------------------------------ */

function renderHeader(table, state, data, onRestore) {
  const partition = (data.partitions ?? []).find((p) => p.name === state.partition);
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'crumbs' },
      h('a', { href: '#/' }, '数据表'),
      h('span', {}, '/'),
      h('span', {}, table.name),
    ),
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', { class: 'inline gap-1' }, table.name, h('span', { class: 'badge mono' }, table.partitionKey)),
        h('p', { class: 'sub' }, table.description || '无描述'),
      ),
      h('span', { class: 'spacer' }),
      h(
        'div',
        { class: 'inline gap-1' },
        h('span', { class: 'badge info' }, `${data.partitions.length} 个分区`),
        h('span', { class: 'badge violet' }, `${data.versions.length} 个版本`),
        h('button', { class: 'btn btn-primary', onClick: onRestore }, '恢复分区'),
      ),
    ),
  );
}

function renderPartitionBar(data, state, rerender) {
  const bar = h('div', { class: 'inline gap-1 mb-2', role: 'tablist', 'aria-label': '分区' });
  for (const partition of data.partitions) {
    const active = partition.name === state.partition;
    bar.appendChild(
      h(
        'button',
        {
          class: `btn btn-sm ${active ? 'btn-primary' : ''}`,
          onClick: () => {
            state.partition = partition.name;
            state.jobId = null;
            state.job = null;
            state.compareVersionId = null;
            rerender();
          },
        },
        partition.name,
        partition.lock ? h('span', { class: 'badge warn', style: { marginLeft: '6px' } }, '恢复中') : h('span', { class: 'faint', style: { marginLeft: '6px' } }, `${partition.fileCount} 文件 · ${fmtNum(partition.rowCount)} 行`),
      ),
    );
  }
  return bar;
}

function renderTimeline(data, state, rerender) {
  const card = h('div', { class: 'card' });
  card.appendChild(
    h(
      'div',
      { class: 'card-head' },
      h('h2', {}, '版本时间线'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'faint', style: { fontSize: '12px' } }, '点击版本查看差异'),
    ),
  );
  const versions = data.versions;
  if (!versions.length) {
    card.appendChild(h('div', { class: 'empty' }, '暂无版本'));
    return card;
  }
  const body = h('div', { class: 'card-body' });
  const timeline = h('div', { class: 'timeline' });
  // versions are newest-first; render newest first
  for (const v of versions) {
    const selected = v.id === state.selectedVersionId;
    const item = h(
      'div',
      {
        class: `tl-item${selected ? ' selected' : ''}`,
        'data-kind': v.kind,
        role: 'button',
        tabindex: '0',
        onClick: () => {
          state.selectedVersionId = v.id;
          rerender();
        },
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            state.selectedVersionId = v.id;
            rerender();
          }
        },
      },
      h('span', { class: 'tl-dot' }),
      h(
        'div',
        { class: 'tl-head' },
        h('span', { class: 'tl-seq' }, `v${v.seq}`),
        h('span', { class: 'tl-label' }, v.label || (v.kind === 'restore' ? '恢复版本' : '提交')),
        h('span', { class: `badge ${v.kind === 'restore' ? 'violet' : 'info'}` }, v.kind === 'restore' ? '恢复' : '提交'),
        v.damagedFiles > 0 ? h('span', { class: 'badge bad' }, `${v.damagedFiles} 损坏`) : null,
      ),
      h(
        'div',
        { class: 'tl-meta' },
        h('span', {}, v.author),
        h('span', {}, fmtTimeShort(v.createdAt)),
        h('span', { title: fmtTime(v.createdAt) }, relativeTime(v.createdAt)),
        h('span', {}, `${v.pageCount} 文件 · ${fmtNum(v.rowCount)} 行`),
        v.reason ? h('span', { class: 'faint', title: v.reason }, `· ${v.reason.length > 30 ? `${v.reason.slice(0, 30)}…` : v.reason}`) : null,
      ),
    );
    timeline.appendChild(item);
  }
  body.appendChild(timeline);
  card.appendChild(body);
  return card;
}

function renderLocksPanel(data) {
  const locks = data.partitions.filter((p) => p.lock);
  if (!locks.length) return h('div', {});
  const card = h('div', { class: 'card' });
  card.appendChild(h('div', { class: 'card-head' }, h('h2', {}, '分区写锁'), h('span', { class: 'badge warn' }, '进行中')));
  const body = h('div', { class: 'card-body stack' });
  for (const p of locks) {
    body.appendChild(
      h(
        'div',
        { class: 'callout warn' },
        h('strong', {}, p.name),
        h('div', { style: { fontSize: '12px', marginTop: '4px' } }, `恢复任务 ${p.lock.id.slice(0, 14)}… 正在执行（${STATE_LABELS[p.lock.state] ?? p.lock.state}）。`),
        h('div', { class: 'hint mt-1' }, '该分区暂不接受并发写入；尝试写入会返回 409。'),
      ),
    );
  }
  card.appendChild(body);
  return card;
}

function renderVersionsMeta(data, state) {
  const v = data.versions.find((x) => x.id === state.selectedVersionId);
  if (!v) return h('div', {});
  const card = h('div', { class: 'card' });
  card.appendChild(h('div', { class: 'card-head' }, h('h2', {}, `版本 v${v.seq} 详情`)));
  const body = h('div', { class: 'card-body stack' });
  const rows = [
    ['版本号', `v${v.seq}`],
    ['标识', v.label || '—'],
    ['类型', v.kind === 'restore' ? '恢复生成' : '人工提交'],
    ['作者', v.author],
    ['时间', fmtTime(v.createdAt, { seconds: true })],
    ['文件/行数', `${v.pageCount} / ${fmtNum(v.rowCount)}`],
    ['体积', fmtBytes(v.totalBytes)],
    ['快照哈希', shortHash(v.snapshotHash, 12)],
    ['基线版本', v.baselineId ? shortHash(v.baselineId, 10) : '—'],
    ['恢复任务', v.restoreJobId ? h('a', { href: `#/jobs/${v.restoreJobId}` }, shortHash(v.restoreJobId, 12)) : '—'],
    ['依据', v.reason || '—'],
  ];
  for (const [k, val] of rows) {
    body.appendChild(
      h(
        'div',
        { class: 'inline between', style: { fontSize: '12.5px' } },
        h('span', { class: 'faint' }, k),
        h('span', { class: 'mono', style: { fontSize: '12px', textAlign: 'right' } }, val),
      ),
    );
  }
  if (v.changes?.length) {
    body.appendChild(h('div', { class: 'divider' }));
    body.appendChild(h('div', { class: 'section-title' }, '本版本变更'));
    for (const change of v.changes) {
      for (const f of change.files ?? []) {
        body.appendChild(
          h(
            'div',
            { class: 'inline between', style: { fontSize: '11.5px' } },
            h('span', { class: 'mono' }, f.path),
            h('span', { class: `badge ${f.action === 'delete' ? 'bad' : f.action === 'keep' ? '' : 'ok'}` }, f.action === 'delete' ? '删除' : f.action === 'keep' ? '保留' : '写入'),
          ),
        );
      }
    }
  }
  card.appendChild(body);
  return card;
}

function renderLiveFiles(data, state) {
  const card = h('div', { class: 'card' });
  card.appendChild(h('div', { class: 'card-head' }, h('h2', {}, '活动分区文件'), h('span', { class: 'spacer' }), h('span', { class: 'faint', style: { fontSize: '12px' } }, state.partition ?? '')));
  const body = h('div', { class: 'card-body tight' });
  const holder = h('div', {}, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), '加载文件…'));
  body.appendChild(holder);
  card.appendChild(body);
  if (state.partition) {
    get(`/api/tables/${state.tableId}/partitions/${encodeURIComponent(state.partition)}/live`)
      .then((res) => {
        clear(holder);
        if (!res.files.length) {
          holder.appendChild(h('div', { class: 'empty' }, '分区为空'));
          return;
        }
        for (const f of res.files) {
          holder.appendChild(
            h(
              'div',
              { class: 'inline between', style: { fontSize: '12px', padding: '5px 0' } },
              h('span', { class: 'mono' }, f.path),
              h('span', { class: 'faint' }, `${fmtNum(f.rows)} 行 · ${fmtBytes(f.bytes)}`),
            ),
          );
        }
      })
      .catch((err) => {
        clear(holder);
        holder.appendChild(h('div', { class: 'callout bad' }, err.message));
      });
  }
  return card;
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

export function openCancelModal(job, done) {
  const operator = h('input', { type: 'text', placeholder: '你的名字', value: null, 'data-field': 'operator' });
  const reason = h('textarea', { placeholder: '取消原因（至少 4 个字符），将写入审计', 'data-field': 'reason' });
  const body = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'callout warn' }, '取消将回滚所有已写入的文件，恢复到发起恢复之前的状态。已生成的中间状态不会保留。'),
    h('label', { class: 'field' }, h('span', {}, '操作者 ', h('span', { class: 'req' }, '*')), operator),
    h('label', { class: 'field' }, h('span', {}, '取消原因 ', h('span', { class: 'req' }, '*')), reason),
  );
  const footer = [
    h('button', { class: 'btn btn-ghost', onClick: () => closeModal() }, '返回'),
    h(
      'button',
      {
        class: 'btn btn-danger',
        onClick: async (e) => {
          try {
            e.target.disabled = true;
            await post(`/api/restores/${job.id}/cancel`, {
              operator: operator.value.trim(),
              reason: reason.value.trim(),
            });
            closeModal();
            ok('任务已取消', '已回滚已应用的写入');
            done();
          } catch (err) {
            bad('取消失败', err.message);
            e.target.disabled = false;
          }
        },
      },
      '取消任务并回滚',
    ),
  ];
  openModal({ title: '取消恢复任务', body, footer });
}

function openRollbackModal(job, done) {
  const operator = h('input', { type: 'text', placeholder: '你的名字' });
  const reason = h('input', { type: 'text', placeholder: '回滚依据（至少 4 个字符）' });
  const body = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'callout warn' }, '回滚会将任务写入过的文件恢复为恢复前备份；未写入文件不受影响。'),
    h('label', { class: 'field' }, h('span', {}, '操作者 ', h('span', { class: 'req' }, '*')), operator),
    h('label', { class: 'field' }, h('span', {}, '回滚依据 ', h('span', { class: 'req' }, '*')), reason),
  );
  const footer = [
    h('button', { class: 'btn btn-ghost', onClick: () => closeModal() }, '取消'),
    h(
      'button',
      {
        class: 'btn btn-warn',
        onClick: async (e) => {
          try {
            e.target.disabled = true;
            await post(`/api/restores/${job.id}/rollback`, { operator: operator.value.trim(), reason: reason.value.trim() });
            closeModal();
            ok('已回滚');
            done();
          } catch (err) {
            bad('回滚失败', err.message);
            e.target.disabled = false;
          }
        },
      },
      '执行回滚',
    ),
  ];
  openModal({ title: '手动回滚已应用文件', body, footer });
}

export function openConflictModal(job, done) {
  const conflicts = job.conflicts ?? [];
  let choice = 'overwrite_target';
  const operator = h('input', { type: 'text', placeholder: '你的名字，将记录为冲突决策人' });
  const reason = h('input', { type: 'text', placeholder: '决策依据（至少 4 个字符）' });

  const choices = [
    { key: 'overwrite_target', title: '覆盖并发写入', desc: '以目标版本为准，丢弃恢复开始后他人写入的改动。适用于确认目标快照更可信。', tone: 'bad' },
    { key: 'keep_current', title: '保留当前文件', desc: '跳过冲突文件，保留他人最新写入。适用于并发写入有效、仅恢复其余文件。', tone: 'ok' },
    { key: 'abort', title: '中止并回滚', desc: '放弃本次恢复，回滚所有已写文件。适用于无法判断孰是孰非。', tone: 'warn' },
  ];
  const gridEl = h('div', { class: 'choice-grid' });
  for (const c of choices) {
    const btn = h(
      'button',
      {
        class: `choice${choice === c.key ? ' selected' : ''}`,
        'data-choice': c.key,
        onClick: () => {
          choice = c.key;
          gridEl.querySelectorAll('.choice').forEach((el) => el.classList.toggle('selected', el.dataset.choice === choice));
        },
      },
      h('div', { class: 't' }, c.key === 'overwrite_target' ? '⚠ ' : c.key === 'keep_current' ? '✓ ' : '⛔ ', c.title),
      h('div', { class: 'd' }, c.desc),
    );
    gridEl.appendChild(btn);
  }

  const fileList = h(
    'div',
    { class: 'stack', style: { gap: '6px' } },
    ...conflicts.map((c) =>
      h(
        'div',
        { class: 'conflict-file' },
        h('span', { class: 'mono' }, c.path),
        h('span', { title: '恢复前基线' }, h('span', { class: 'hashpill' }, shortHash(c.baselineChecksum, 8))),
        h('span', { title: '并发写入后的当前值', style: { color: 'var(--warn)' } }, h('span', { class: 'hashpill' }, shortHash(c.liveChecksum, 8))),
        h('span', { title: '目标版本' }, h('span', { class: 'hashpill' }, shortHash(c.targetChecksum, 8))),
      ),
    ),
  );

  const body = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'conflict-banner' },
      h('span', { class: 'ic' }, '⚠️'),
      h(
        'div',
        {},
        h('h3', {}, `检测到 ${conflicts.length} 个文件被并发修改`),
        h('p', {}, '恢复开始后，其他写入者修改了这些文件。为避免覆盖他人数据，恢复已暂停，需要你明确选择处理方式。'),
      ),
    ),
    h('div', { class: 'section-title' }, '冲突文件（基线 / 当前 / 目标 校验和）'),
    fileList,
    gridEl,
    h('div', { class: 'grid cols-2' }, h('label', { class: 'field' }, h('span', {}, '决策操作者 ', h('span', { class: 'req' }, '*')), operator), h('label', { class: 'field' }, h('span', {}, '决策依据 ', h('span', { class: 'req' }, '*')), reason)),
    h('div', { class: 'hint' }, '冲突决策会连同文件校验和、操作者、依据一起写入不可篡改的审计链。'),
  );
  const footer = [
    h('button', { class: 'btn btn-ghost', onClick: () => closeModal() }, '稍后处理'),
    h(
      'button',
      {
        class: 'btn btn-primary',
        onClick: async (e) => {
          try {
            e.target.disabled = true;
            const res = await post(`/api/restores/${job.id}/conflict`, {
              action: choice,
              operator: operator.value.trim(),
              reason: reason.value.trim(),
            });
            closeModal();
            ok('冲突已处理', `按“${choices.find((c) => c.key === choice).title}”继续执行`);
            done(res);
          } catch (err) {
            bad('处理冲突失败', err.message);
            e.target.disabled = false;
          }
        },
      },
      '确认并继续',
    ),
  ];
  openModal({ title: '并发写入冲突', body, footer, wide: true });
}
