/* global console, process, setTimeout, window, performance, URL, ClipboardEvent, DataTransfer */
// Integration checks against the real frontend; IPC is the browser adapter.
// Run with QA_PLAYWRIGHT pointing to an installed playwright package, and pnpm dev.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
await mkdir('artifacts/qa', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, locale: 'zh-CN' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', dialog => dialog.dismiss());
const checks = [];
async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function setting(key, value) {
  await page.evaluate(async ({ key, value }) => (await window.__qaImport('/src/core/settings.ts')).setSetting(key, value), { key, value });
}
async function command(id, args) {
  return page.evaluate(async ({ id, args }) => (await window.__qaImport('/src/core/commands.ts')).executeCommand(id, args), { id, args });
}
async function active() {
  return page.evaluate(async () => {
    const { activeTab, tabText } = await window.__qaImport('/src/editor/tabs.ts');
    const tab = activeTab();
    return tab && { id: tab.id, doc: tab.doc, text: tabText(tab) };
  });
}
async function eventually(fn, message) {
  for (let i = 0; i < 50; i++) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
try {
  await page.goto(process.env.QA_URL || 'http://127.0.0.1:1420');
  await page.waitForSelector('[role=toolbar]');
  await page.evaluate(() => {
    window.__qaImport = (path) => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path)?.name ?? path);
  });
  await check('browser adapter boots without eager Tauri access', async () => assert.deepEqual(errors, []));
  await command('settings.open');
  await page.waitForSelector('.settings-page');
  await check('general settings expose nine switches and five dropdowns', async () => {
    assert.equal(await page.locator('.st-general [role=switch]').count(), 9);
    assert.equal(await page.locator('.st-general [role=combobox]').count(), 5);
    assert.equal(await page.locator('.st-title').innerText(), '常规');
  });
  await page.screenshot({ path: 'artifacts/qa/general-zh-CN.png' });
  await check('switch click and dropdown keyboard input persist values', async () => {
    await page.getByRole('switch', { name: '自动换行', exact: true }).click();
    assert.equal(await page.evaluate(async () => (await window.__qaImport('/src/core/settings.ts')).getSetting('editor.wordWrap')), true);
    const eol = page.getByRole('combobox', { name: '默认换行符', exact: true });
    await eol.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(async () => (await window.__qaImport('/src/core/settings.ts')).getSetting('files.defaultEol')), 'LF');
  });
  await command('file.new');
  const first = await active();
  await page.locator('.cm-content').click();
  await page.keyboard.type('alpha');
  await check('default metadata changes affect only future documents', async () => {
    await setting('files.defaultEol', 'CR');
    await setting('files.defaultEncoding', 'utf-16be-bom');
    assert.equal((await active()).doc.eol, 'LF');
    assert.equal((await active()).doc.hasBom, false);
    await command('file.new');
    assert.equal((await active()).doc.eol, 'CR');
    assert.equal((await active()).doc.hasBom, true);
    assert.match((await active()).doc.encoding.toLowerCase().replace(/-/g, ''), /utf16be/);
  });
  await check('Tab setting changes new input and preserves an existing tab', async () => {
    await setting('editor.tabBehavior', 'tab');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Tab');
    assert.equal((await active()).text, '\t');
    await setting('editor.tabBehavior', 'spaces4');
    await page.keyboard.press('Tab');
    assert.equal((await active()).text, '\t    ');
  });
  await check('line numbers and active line update immediately', async () => {
    await setting('editor.lineNumbers', false);
    await setting('editor.highlightActiveLine', false);
    assert.equal(await page.locator('.cm-lineNumbers').count(), 0);
    assert.equal(await page.locator('.cm-activeLine').count(), 0);
    await setting('editor.lineNumbers', true);
    await setting('editor.highlightActiveLine', true);
    assert.equal(await page.locator('.cm-lineNumbers').count(), 1);
    assert.equal(await page.locator('.cm-activeLine').count(), 1);
  });
  await check('word wrap applies to all open documents', async () => {
    await setting('editor.wordWrap', false);
    assert.equal(await page.locator('.cm-lineWrapping').count(), 0);
    await setting('editor.wordWrap', true);
    await command('tab.activate', first.id);
    assert.equal(await page.locator('.cm-lineWrapping').count(), 1);
  });
  await check('pointer drag reorders tabs and Escape restores their order', async () => {
    const ids = () => page.locator('.tabbar > [data-tab-id]').evaluateAll(nodes => nodes.map(node => node.dataset.tabId));
    const before = await ids();
    const moving = page.locator(`.tabbar > [data-tab-id="${first.id}"]`);
    const from = await moving.boundingBox();
    const last = await page.locator('.tabbar > [data-tab-id]').last().boundingBox();
    await page.mouse.move(from.x + 18, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width - 3, last.y + last.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.deepEqual(await ids(), [...before.filter(id => id !== first.id), first.id]);
    const ordered = await ids();
    const moved = await moving.boundingBox();
    const start = await page.locator('.tabbar > [data-tab-id]').first().boundingBox();
    await page.mouse.move(moved.x + 18, moved.y + moved.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 2, start.y + start.height / 2, { steps: 8 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.deepEqual(await ids(), ordered);
  });
  await check('pointer drag outside requests a window and failed creation retains the draft', async () => {
    await page.evaluate(async () => {
      const { ipc } = await window.__qaImport('/src/ipc/index.ts');
      window.qaOpenRequests = [];
      window.qaRestoreOpen = ipc.windowOpen;
      ipc.windowOpen = async opts => { window.qaOpenRequests.push(opts); throw new Error('simulated window creation failure'); };
    });
    const before = await active();
    const tab = await page.locator(`.tabbar > [data-tab-id="${first.id}"]`).boundingBox();
    await page.mouse.move(tab.x + 18, tab.y + tab.height / 2);
    await page.mouse.down();
    await page.mouse.move(tab.x + 18, -25, { steps: 8 });
    await page.mouse.up();
    await eventually(async () => (await page.evaluate(() => window.qaOpenRequests.length)) === 1, 'outside drag did not request a new window');
    assert.equal((await active()).text, before.text);
    assert.equal((await active()).id, before.id);
    await page.evaluate(async () => { (await window.__qaImport('/src/ipc/index.ts')).ipc.windowOpen = window.qaRestoreOpen; });
  });
  await check('smart copy trims only selection edges', async () => {
    await setting('editor.smartCopy', true);
    const result = await page.evaluate(async () => {
      const { getView } = await window.__qaImport('/src/editor/tabs.ts');
      const view = getView();
      const text = ' \n\t alpha\n  beta \t\n ';
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0, head: text.length } });
      const data = new DataTransfer();
      view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
      return data.getData('text/plain');
    });
    assert.equal(result, 'alpha\n  beta');
  });
  await check('status bar visibility and encoding submenu work', async () => {
    await setting('workbench.statusBar', false);
    assert.equal(await page.locator('.statusbar').isVisible(), false);
    await setting('workbench.statusBar', true);
    await page.locator('.sb-enc').click();
    await page.getByRole('menuitem', { name: '通过编码保存', exact: true }).hover();
    await page.waitForSelector('.sb-menu.menu-sub');
    assert.ok(await page.locator('.sb-menu.menu-sub [role=menuitemradio]').count() >= 5);
    await page.screenshot({ path: 'artifacts/qa/encoding-menu.png' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('.sb-eol').click();
    await page.getByRole('menuitemradio', { name: /Macintosh/ }).click();
    assert.equal((await active()).doc.eol, 'CR');
    assert.equal((await active()).doc.dirty, true);
  });
  await check('all four languages switch settings and document title', async () => {
    for (const [locale, title, section] of [['en', 'silk book', 'General'], ['zh-TW', '帛書', '一般'], ['ja', '帛書', '一般'], ['zh-CN', '帛书', '常规']]) {
      await setting('workbench.language', locale);
      await eventually(async () => await page.title() === title && await page.locator('html').getAttribute('lang') === locale, `locale ${locale} did not settle`);
      await command('settings.open');
      await page.waitForSelector('.settings-page');
      // Translation phrasing is deliberately not constrained except the English UI.
      if (locale === 'en') assert.equal(await page.locator('.st-title').innerText(), section);
      await page.screenshot({ path: `artifacts/qa/general-${locale}.png` });
    }
  });
  await check('CodeMirror search panel uses active UI language', async () => {
    await command('tab.activate', first.id);
    await command('editor.find');
    assert.ok((await page.locator('.cm-search').innerText()).includes('替换'));
  });
  await check('settings remain usable at minimum window size', async () => {
    await page.setViewportSize({ width: 640, height: 400 });
    await command('settings.open');
    const language = page.locator('.st-general [role=combobox]').last();
    await language.scrollIntoViewIfNeeded();
    await language.click();
    await page.screenshot({ path: 'artifacts/qa/general-compact.png' });
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await eventually(async () => await page.title() === 'silk book', 'compact language dropdown is not usable');
  });
  await check('no unhandled frontend exceptions', async () => assert.deepEqual(errors, []));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser.close();
}
