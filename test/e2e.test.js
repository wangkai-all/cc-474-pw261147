import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './browser.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timevault-e2e-'));
process.env.TV_DATA_DIR = tmp;
process.env.TV_JOB_TICK_MS = '5';

const { seedDatabase } = await import('../server/seed.js');
const { createServer } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');

seedDatabase({ force: true });
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
let page;
const errors = [];

test.before(async () => {
  browser = await launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (err) => errors.push(`PAGEERROR ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE ${msg.text()}`);
  });
});

test.after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const apiPost = async (url, body) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const apiGet = async (url) => (await fetch(base + url)).json();

test('home page lists both tables with version metadata', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.table-grid .table-card');
  const cards = await page.$$('.table-grid .table-card');
  assert.equal(cards.length, 2);
  const text = await page.textContent('.table-grid');
  assert.match(text, /dwd_orders/);
  assert.match(text, /dwd_shipments/);
  assert.match(text, /当前版本/);
});

test('table detail shows timeline, diff summary and downstream impact', async () => {
  await page.goto(`${base}/#/table/tbl_orders?partition=city=chengdu`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.timeline .tl-item');
  const tlCount = await page.$$eval('.timeline .tl-item', (els) => els.length);
  assert.ok(tlCount >= 5);

  // select the incident version v4
  await page.locator('.tl-item').filter({ hasText: 'v4' }).first().click();
  await page.waitForSelector('.diff-summary .chip-stat');
  await page.waitForTimeout(400);
  const summary = await page.textContent('.diff-summary');
  assert.match(summary, /新增文件/);
  const impact = await page.textContent('.grid');
  assert.match(impact, /差异与下游影响/);
  const impactNames = await page.$$eval('.impact-item .impact-name', (els) => els.map((e) => e.textContent));
  assert.ok(impactNames.length >= 1, 'downstream consumers rendered');
});

test('restore dialog creates a job and progress panel completes', async () => {
  await page.getByRole('button', { name: '恢复分区' }).click();
  await page.waitForSelector('.modal');
  await page.locator('.modal input[type=text]').first().fill('李京');
  await page.locator('.modal textarea').fill('E2E 测试恢复成都分区');
  await page.locator('.modal').getByRole('button', { name: '创建恢复任务' }).click();
  await page.waitForSelector('.toast', { timeout: 5000 });

  await page.waitForSelector('.card-head:has-text("恢复进度")', { timeout: 5000 });
  await page.waitForFunction(
    () => {
      const badge = [...document.querySelectorAll('.card-head .badge')].find((b) => b.textContent.includes('已完成'));
      return Boolean(badge);
    },
    { timeout: 15000 },
  );
  const progressText = await page.textContent('.card:has(.card-head:has-text("恢复进度"))');
  assert.match(progressText, /100%/);
  assert.match(progressText, /已完成/);
});

test('jobs page lists the completed restore and audit page verifies chain', async () => {
  await page.goto(`${base}/#/jobs`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.job-item');
  const jobText = await page.textContent('.job-item');
  assert.match(jobText, /李京|已完成/);

  await page.goto(`${base}/#/audit`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.audit-item');
  const badge = await page.textContent('.card-body .badge');
  assert.match(badge, /审计链完整/);
  const events = await page.$$eval('.audit-item', (els) => els.length);
  assert.ok(events >= 3);
});

test('conflict surfaces in the UI and can be resolved in the dialog', async () => {
  // prepare drift + baseline
  await apiPost('/api/restores', { tableId: 'tbl_orders', partition: 'city=chengdu', seq: 4, operator: '李京', reason: '准备 UI 冲突基线' });
  await page.waitForTimeout(400);

  await page.goto(`${base}/#/table/tbl_orders?partition=city=chengdu`, { waitUntil: 'networkidle' });
  // create a restore with a settle window via API
  const created = await apiPost('/api/restores', {
    tableId: 'tbl_orders',
    partition: 'city=chengdu',
    seq: 4,
    operator: '李京',
    reason: 'UI 冲突测试',
    settleMs: 900,
  });
  await page.waitForTimeout(120);
  await apiPost('/api/tables/tbl_orders/commit', {
    partition: 'city=chengdu',
    operator: '陈数',
    reason: '并发写入',
    files: [{ path: 'part-001.ndjson', rows: [{ order_id: 'ui-concurrent' }] }],
  });

  await page.goto(`${base}/#/table/tbl_orders?job=${created.job.id}&partition=city=chengdu`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.conflict-banner, .card-head:has-text("并发写入冲突")', { timeout: 10000 });
  await page.getByRole('button', { name: '选择处理方式…' }).click();
  await page.waitForSelector('.choice-grid');
  await page.locator('.modal input[type=text]').first().fill('王点');
  await page.locator('.modal input[type=text]').nth(1).fill('UI 上确认保留并发写入');
  await page.getByRole('button', { name: '确认并继续' }).click();
  await page.waitForTimeout(2000);
  const job = (await apiGet(`/api/restores/${created.job.id}`)).job;
  assert.equal(job.state, 'completed');
  assert.ok(job.conflictCount >= 1);
});

test('no uncaught page errors occurred', () => {
  const relevant = errors.filter((e) => !e.includes('favicon'));
  assert.deepEqual(relevant, []);
});
