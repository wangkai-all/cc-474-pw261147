import { h, clear } from './dom.js';
import { get } from './api.js';
import { info, bad, openModal, closeModal } from './ui.js';
import { renderTables } from './views/tables.js';
import { renderTable } from './views/table.js';
import { renderJobs } from './views/jobs.js';
import { renderAudit } from './views/audit.js';

const app = document.getElementById('app');

export function navigate(path) {
  location.hash = path;
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = hash.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart ?? ''));
  if (segments.length === 0) return { name: 'tables', query };
  if (segments[0] === 'jobs') return { name: 'jobs', id: segments[1] ?? null, query };
  if (segments[0] === 'audit') return { name: 'audit', query };
  if (segments[0] === 'table' && segments[1]) {
    return { name: 'table', tableId: segments[1], partition: query.partition ?? null, version: query.version ?? null, job: query.job ?? null, query };
  }
  return { name: 'tables', query };
}

let currentCleanup = null;

export function setCleanup(fn) {
  currentCleanup = fn;
}

async function render() {
  const route = parseRoute();
  if (typeof currentCleanup === 'function') currentCleanup();
  currentCleanup = null;
  document.querySelectorAll('#topnav a').forEach((a) => {
    const nav = a.dataset.nav;
    const active = (route.name === 'table' && nav === 'tables') || nav === route.name || (route.name === 'jobs' && nav === 'jobs');
    a.classList.toggle('active', Boolean(active));
  });
  clear(app);
  try {
    if (route.name === 'table') await renderTable(app, route);
    else if (route.name === 'jobs') await renderJobs(app, route);
    else if (route.name === 'audit') await renderAudit(app, route);
    else await renderTables(app, route);
  } catch (err) {
    console.error(err);
    app.appendChild(
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-body' },
          h('div', { class: 'callout bad' }, h('strong', {}, '页面加载失败：'), err.message),
          h('div', { class: 'mt-2' }, h('button', { class: 'btn btn-sm', onClick: () => render() }, '重试')),
        ),
      ),
    );
    bad('页面加载失败', err.message);
  }
}

async function refreshHealth() {
  const pill = document.getElementById('health-pill');
  try {
    const health = await get('/api/health');
    pill.className = 'pill ok';
    pill.innerHTML = '<span class="dot"></span><span>已连接</span>';
    if (!health.seeded) {
      info('演示数据为空', '点击右上角“重置演示数据”生成示例表与版本历史');
    }
  } catch {
    pill.className = 'pill bad';
    pill.innerHTML = '<span class="dot"></span><span>连接失败</span>';
  }
}

document.getElementById('btn-demo').addEventListener('click', () => {
  const body = h(
    'div',
    { class: 'stack' },
    h('p', { class: 'muted' }, '重置将清空当前所有数据表、版本历史、恢复记录与审计日志，并重新生成演示数据。此操作不可撤销。'),
    h('div', { class: 'callout warn' }, '正在进行的恢复任务会被终止，活动分区文件将被覆盖。'),
  );
  const footer = [
    h('button', { class: 'btn btn-ghost', onClick: () => closeModal() }, '取消'),
    h(
      'button',
      {
        class: 'btn btn-danger',
        onClick: async (e) => {
          e.target.disabled = true;
          try {
            await fetch('/api/admin/seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) });
            closeModal();
            info('演示数据已重置');
            location.hash = '#/';
            await render();
          } catch (err) {
            bad('重置失败', err.message);
            e.target.disabled = false;
          }
        },
      },
      '确认重置',
    ),
  ];
  openModal({ title: '重置演示数据', body, footer });
});

window.addEventListener('hashchange', render);

refreshHealth();
setInterval(refreshHealth, 20000);
render();
