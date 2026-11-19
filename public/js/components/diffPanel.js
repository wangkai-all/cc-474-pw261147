import { h, clear } from '../dom.js';
import { get, post } from '../api.js';
import { bad, ok, info } from '../ui.js';
import { fmtBytes, fmtDelta, fmtNum, shortHash, fmtTime } from '../format.js';

const ROW_TONE = { added: 'added', removed: 'removed', changed: 'changed' };

export async function renderDiffPanel({ table, partition, version, versions, comparison, compareVersionId, onChange, onRestore }) {
  const card = h('div', { class: 'card' });
  card.appendChild(
    h(
      'div',
      { class: 'card-head' },
      h('h2', {}, '差异与下游影响'),
      h('span', { class: 'spacer' }),
      renderComparisonSwitch(),
    ),
  );
  const body = h('div', { class: 'card-body' });
  body.appendChild(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), '正在计算差异…'));
  card.appendChild(body);

  const baseLabel = comparison === 'version' ? `版本 ${versionLabel(versions, compareVersionId)}` : '当前活动分区';

  post('/api/tables/' + table.id + '/diff', {
    partition,
    versionId: version.id,
    fromVersionId: comparison === 'version' ? compareVersionId : undefined,
  })
    .then(({ diff, impact }) => {
      clear(body);
      body.appendChild(renderSummary(diff));
      if (diff.damagedFileCount > 0) {
        body.appendChild(
          h(
            'div',
            { class: 'callout bad mt-2' },
            h('strong', {}, `⚠ ${diff.damagedFileCount} 个文件无法读取`),
            h('div', { style: { marginTop: '4px' } }, '目标版本的对象损坏或丢失。恢复前必须先修复，否则任务会在完整性校验阶段被阻断。'),
            ...diff.damagedFiles.map((d) => h('div', { class: 'hint mt-1 mono' }, `${d.path}: ${d.reason}`)),
          ),
        );
      }
      body.appendChild(renderFileList(diff));
      body.appendChild(renderRowSamples(diff));
      body.appendChild(renderImpact(impact, diff));
      body.appendChild(
        h(
          'div',
          { class: 'inline gap-1 mt-2' },
          h('button', { class: 'btn btn-primary', onClick: onRestore }, `恢复到 v${version.seq}`),
          h('button', { class: 'btn', onClick: () => previewVersion({ table, partition, version, onChange }) }, '预览目标版本行'),
        ),
      );
    })
    .catch((err) => {
      clear(body);
      body.appendChild(h('div', { class: 'callout bad' }, h('strong', {}, '差异计算失败：'), err.message));
      body.appendChild(h('div', { class: 'hint mt-1' }, `比较基准：${baseLabel}`));
    });

  return card;

  function renderComparisonSwitch() {
    const wrap = h('div', { class: 'inline gap-1' });
    const liveBtn = h(
      'button',
      {
        class: `btn btn-sm${comparison === 'live' ? ' btn-primary' : ''}`,
        onClick: () => onChange({ comparison: 'live', compareVersionId: null }),
      },
      '对比当前',
    );
    const verBtn = h(
      'button',
      {
        class: `btn btn-sm${comparison === 'version' ? ' btn-primary' : ''}`,
        onClick: () =>
          onChange({
            comparison: 'version',
            compareVersionId: compareVersionId ?? versions.find((v) => v.seq === version.seq - 1)?.id ?? versions[0]?.id ?? null,
          }),
      },
      '对比版本',
    );
    wrap.appendChild(liveBtn);
    wrap.appendChild(verBtn);
    if (comparison === 'version') {
      const select = h(
        'select',
        {
          style: { width: '190px', padding: '4px 8px', fontSize: '12px' },
          onChange: (e) => onChange({ compareVersionId: e.target.value, comparison: 'version' }),
        },
        h('option', { value: '' }, '选择基线版本'),
        ...versions
          .filter((v) => v.seq < version.seq)
          .map((v) => h('option', { value: v.id, selected: v.id === compareVersionId }, `v${v.seq} · ${v.label || '提交'}`)),
      );
      wrap.appendChild(select);
    }
    return wrap;
  }
}

function versionLabel(versions, id) {
  const v = versions.find((x) => x.id === id);
  return v ? `v${v.seq}` : '—';
}

function renderSummary(diff) {
  const s = diff.summary;
  const el = h(
    'div',
    { class: 'diff-summary' },
    stat(s.added, '新增文件', 'add'),
    stat(s.modified, '修改文件', 'mod'),
    stat(s.removed, '删除文件', 'del'),
    stat(s.unchanged, '未变化', ''),
    h('div', { class: 'chip-stat' }, h('span', { class: 'v' }, fmtDelta(s.rowsDelta)), h('span', { class: 'k' }, '净行数变化')),
    h('div', { class: 'chip-stat' }, h('span', { class: 'v' }, fmtDelta(s.bytesDelta)), h('span', { class: 'k' }, '字节变化')),
  );
  return el;
}

function stat(value, label, tone) {
  return h('div', { class: `chip-stat ${tone}` }, h('span', { class: 'v' }, fmtNum(value)), h('span', { class: 'k' }, label));
}

function renderFileList(diff) {
  const wrap = h('div', { class: 'mt-1' });
  wrap.appendChild(h('div', { class: 'section-title' }, '文件级差异'));
  for (const file of diff.files) {
    const markerClass = file.damaged ? 'damaged' : file.change;
    const row = h(
      'div',
      { class: 'file-row' },
      h('span', { class: `marker ${markerClass}`, title: file.damaged ? '文件损坏' : changeLabel(file.change) }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'fpath' }, file.path), file.damaged ? h('div', { class: 'hint', style: { color: 'var(--danger)' } }, file.damaged) : null),
      h(
        'div',
        { class: 'file-mini' },
        h('span', {}, file.change === 'added' ? '—' : fmtBytes(file.baseline?.bytes ?? 0)),
        h('span', {}, '→'),
        h('span', {}, file.change === 'removed' ? '—' : fmtBytes(file.target?.bytes ?? 0)),
      ),
      h(
        'div',
        { class: 'file-mini' },
        file.rowDiff && !file.rowDiff.unavailable
          ? h(
              'span',
              { title: '行变化' },
              file.rowDiff.added ? h('span', { style: { color: 'var(--ok)' } }, `+${file.rowDiff.added}`) : null,
              file.rowDiff.removed ? h('span', { style: { color: 'var(--danger)', marginLeft: '5px' } }, `-${file.rowDiff.removed}`) : null,
              file.rowDiff.changed ? h('span', { style: { color: 'var(--warn)', marginLeft: '5px' } }, `~${file.rowDiff.changed}`) : null,
            )
          : h('span', { class: 'faint' }, changeLabel(file.change)),
      ),
    );
    wrap.appendChild(row);
  }
  return wrap;
}

function renderRowSamples(diff) {
  if (!diff.rows?.length) return h('div', {});
  const wrap = h('div', { class: 'diff-rows' });
  const head = h(
    'div',
    { class: 'inline between', style: { padding: '8px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg-elev-2)' } },
    h('span', { class: 'section-title', style: { margin: 0 } }, '行级差异样本'),
    h('span', { class: 'hint' }, diff.rowsTruncated ? '已截断，仅展示部分样本' : `${diff.rows.length} 条`),
  );
  wrap.appendChild(head);
  for (const sample of diff.rows) {
    const tag = ROW_TONE[sample.kind] ?? 'changed';
    let bodyText;
    if (sample.kind === 'changed') {
      bodyText = h(
        'div',
        { class: 'body' },
        h('span', { class: 'kv' }, `key=${sample.key}  `),
        ...(sample.changedFields ?? []).map((field) =>
          h(
            'span',
            { style: { marginRight: '14px' } },
            h('span', { class: 'kv' }, `${field}: `),
            h('span', { class: 'del-text' }, JSON.stringify(sample.before?.[field])),
            ' → ',
            h('span', { class: 'add-text' }, JSON.stringify(sample.after?.[field])),
          ),
        ),
      );
    } else {
      const row = sample.after ?? sample.before ?? {};
      bodyText = h(
        'div',
        { class: 'body' },
        h('span', { class: 'kv' }, `key=${sample.key}  `),
        Object.entries(row)
          .slice(0, 8)
          .map(([k, v]) => h('span', { style: { marginRight: '12px' } }, h('span', { class: 'kv' }, `${k}=`), JSON.stringify(v)))
          .reduce((acc, x) => (acc.push(x), acc), []),
      );
    }
    wrap.appendChild(h('div', { class: `diff-row ${tag}` }, h('div', { class: 'tag' }, kindLabel(sample.kind)), bodyText));
  }
  return wrap;
}

function renderImpact(impact, diff) {
  const wrap = h('div', { class: 'mt-2' });
  wrap.appendChild(
    h(
      'div',
      { class: 'inline between' },
      h('div', { class: 'section-title', style: { margin: 0 } }, '下游影响'),
      h(
        'div',
        { class: 'inline gap-1' },
        h('span', { class: 'badge' }, `${impact.downstreamCount} 个下游任务`),
        impact.highSeverityCount ? h('span', { class: 'badge bad' }, `${impact.highSeverityCount} 个高优先级`) : null,
      ),
    ),
  );
  if (!impact.downstream.length) {
    wrap.appendChild(h('div', { class: 'callout ok mt-1' }, '未发现依赖该分区的下游任务。'));
    return wrap;
  }
  const list = h('div', { class: 'mt-1' });
  for (const dep of impact.downstream) {
    list.appendChild(
      h(
        'div',
        { class: 'impact-item' },
        h('span', { class: `sev-bar sev-${dep.severity}` }),
        h(
          'div',
          { class: 'impact-main' },
          h(
            'div',
            { class: 'impact-name' },
            dep.name,
            h('span', { class: `badge ${dep.severity === 'high' ? 'bad' : dep.severity === 'medium' ? 'warn' : ''}` }, severityLabel(dep.severity)),
            h('span', { class: 'badge' }, dep.type),
            dep.schedule ? h('span', { class: 'hint' }, dep.schedule) : null,
          ),
          h('div', { class: 'impact-note' }, dep.action),
          h(
            'div',
            { class: 'impact-deps' },
            h('span', {}, `Owner: ${dep.owner || '未指定'}`),
            h('span', {}, `依赖分区: ${dep.dependsOnPartitions.join(', ')}`),
            dep.dependsOnColumns.length ? h('span', {}, `依赖字段: ${dep.dependsOnColumns.join(', ')}`) : null,
            dep.slaMinutes ? h('span', {}, `SLA ${dep.slaMinutes} 分钟`) : null,
          ),
        ),
      ),
    );
  }
  wrap.appendChild(list);
  return wrap;
}

function changeLabel(change) {
  return { added: '新增', modified: '修改', removed: '删除', unchanged: '未变化' }[change] ?? change;
}
function kindLabel(kind) {
  return { added: '新增', removed: '删除', changed: '修改' }[kind] ?? kind;
}
function severityLabel(sev) {
  return { high: '高影响', medium: '中影响', low: '低影响' }[sev] ?? sev;
}

async function previewVersion({ table, partition, version, onChange }) {
  const files = version.manifest.filter((f) => f.partition === partition);
  const body = h('div', { class: 'stack' });
  if (!files.length) {
    body.appendChild(h('div', { class: 'empty' }, '该版本在此分区没有文件'));
  } else {
    body.appendChild(h('div', { class: 'hint' }, `版本 v${version.seq} 快照内容（来自不可变对象存储）`));
    for (const file of files) {
      body.appendChild(
        h(
          'div',
          { class: 'inline between', style: { fontSize: '12px', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' } },
          h('span', { class: 'mono' }, file.path),
          h('span', { class: 'faint' }, `${fmtNum(file.rows)} 行 · ${fmtBytes(file.bytes)} · ${shortHash(file.checksum, 8)}`),
        ),
      );
    }
  }
  const switcher = h('div', { class: 'tabs mt-2' });
  const content = h('div', { class: 'mt-1' });
  let activePath = files[0]?.path ?? null;
  for (const file of files) {
    const btn = h('button', { class: activePath === file.path ? 'active' : '', onClick: () => load(file.path) }, file.path);
    switcher.appendChild(btn);
  }
  body.appendChild(switcher);
  body.appendChild(content);

  async function load(path) {
    clear(content);
    content.appendChild(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), '加载…'));
    try {
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      const res = await get(`/api/tables/${table.id}/partitions/${encodeURIComponent(partition)}/versions/${version.id}/files/${encodedPath}`);
      clear(content);
      content.appendChild(renderTableOfRows(res.rows));
    } catch (err) {
      clear(content);
      content.appendChild(h('div', { class: 'callout bad' }, err.message));
    }
    switcher.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.textContent === path));
  }

  if (activePath) await load(activePath);
  const { openModal, closeModal } = await import('../ui.js');
  openModal({ title: `预览版本 v${version.seq}`, body, wide: true, footer: [h('button', { class: 'btn', onClick: () => closeModal() }, '关闭')] });
}

function renderTableOfRows(rows) {
  if (!rows?.length) return h('div', { class: 'empty' }, '文件为空');
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const table = h(
    'table',
    { class: 'data' },
    h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', {}, c)))),
    h(
      'tbody',
      {},
      ...rows.slice(0, 50).map((row) => h('tr', {}, ...cols.map((c) => h('td', { class: 'mono' }, formatCell(row[c]))))),
    ),
  );
  return h('div', { class: 'scroll-x', style: { maxHeight: '420px' } }, table);
}

function formatCell(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
