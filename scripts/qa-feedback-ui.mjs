/* global console, process, window, performance, URL, getComputedStyle */
// User feedback: real stacking hit tests, glass materials and association layout.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
const output = 'artifacts/qa-feedback';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: 'zh-CN' });
const failures = [];
let passed = 0;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
async function command(id, args) {
  return page.evaluate(async ({ id, args }) => (await window.__qaImport('/src/core/commands.ts')).executeCommand(id, args), { id, args });
}
async function setting(key, value) {
  await page.evaluate(async ({ key, value }) => (await window.__qaImport('/src/core/settings.ts')).setSetting(key, value), { key, value });
}
try {
  await page.goto('http://127.0.0.1:1420');
  await page.waitForSelector('[role=toolbar]');
  await page.evaluate(() => {
    window.__qaImport = path => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path)?.name ?? path);
  });
  await setting('workbench.language', 'zh-CN');
  await command('file.new');
  await page.locator('.cm-content').fill(Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：search and replace / 毛玻璃面板与菜单层级检查`).join('\n'));
  for (const theme of ['glass-dark', 'glass-light', 'dark', 'light']) {
    await setting('workbench.theme', theme);
    await command('editor.find');
    await command('menu.open');
    await page.waitForSelector('.menu');
    const surfaces = await page.evaluate(() => {
      const panel = window.document.querySelector('.cm-panels');
      const menu = window.document.querySelector('.menu');
      const read = el => {
        const s = getComputedStyle(el);
        return { image: s.backgroundImage, color: s.backgroundColor, blur: s.backdropFilter, z: s.zIndex };
      };
      const p = panel.getBoundingClientRect(); const m = menu.getBoundingClientRect();
      const x = Math.max(p.left, m.left) + 24; const y = Math.max(p.top, m.top) + 12;
      return { panel: read(panel), menu: read(menu), menuOnTop: !!window.document.elementFromPoint(x, y)?.closest('.menu') };
    });
    console.log(`SURFACES ${theme} ${JSON.stringify(surfaces)}`);
    await check(`${theme}: hamburger menu receives pointer above search panel`, () => assert.equal(surfaces.menuOnTop, true));
    if (theme.startsWith('glass-')) await check(`${theme}: search uses the same glass material as hamburger menu`, () => {
      assert.match(surfaces.panel.blur, /blur/);
      assert.equal(surfaces.panel.blur, surfaces.menu.blur);
      assert.equal(surfaces.panel.image, surfaces.menu.image);
      assert.equal(surfaces.panel.color, surfaces.menu.color);
    });
    await page.screenshot({ path: `${output}/search-menu-${theme}.png` });
    await page.keyboard.press('Escape');
  }
  await command('settings.open');
  await page.getByRole('tab', { name: '文件关联', exact: true }).click();
  await setting('workbench.theme', 'glass-dark');
  await setting('workbench.fontFamily', 'Maple Mono NF CN');
  await setting('workbench.fontSize', 15);
  for (const width of [1000, 640]) {
    await page.setViewportSize({ width, height: 700 });
    await page.locator('.st-note').scrollIntoViewIfNeeded();
    await check(`${width}px: association notice and first heading have clear spacing`, async () => {
      const note = await page.locator('.st-note').boundingBox();
      const head = await page.locator('.st-ext-head').first().boundingBox();
      assert.ok(head.y - (note.y + note.height) >= 12, `gap: ${head.y - (note.y + note.height)}`);
    });
    await check(`${width}px: extension labels and badges fit without wrapping or overflow`, async () => {
      const issues = await page.locator('.st-ext').evaluateAll(nodes => nodes.flatMap(node => {
        const box = node.getBoundingClientRect();
        const badge = node.querySelector('.st-badge'); const s = getComputedStyle(badge);
        return badge.getBoundingClientRect().height > parseFloat(s.lineHeight) + 3 || node.scrollWidth > box.width + 1 ? [node.textContent] : [];
      }));
      assert.deepEqual(issues, []);
      assert.equal(await page.locator('.st-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    });
    await page.screenshot({ path: `${output}/associations-${width}.png` });
  }
  await check('no unhandled frontend exceptions', () => assert.deepEqual(errors, []));
  console.log(JSON.stringify({ passed, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally { await browser.close(); }
