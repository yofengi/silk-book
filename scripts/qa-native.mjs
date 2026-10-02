/* global console, process, setTimeout, window, performance, URL, TextEncoder */
// Requires an isolated debug Boshu instance with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
// containing --remote-debugging-port=9223, and the local Vite dev server.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
let browser;
let connectError;
for (let attempt = 0; attempt < 40 && !browser; attempt++) {
  try { browser = await chromium.connectOverCDP(process.env.QA_CDP || 'http://127.0.0.1:9223'); }
  catch (error) { connectError = error; await new Promise(resolve => setTimeout(resolve, 250)); }
}
if (!browser) throw connectError;
const context = browser.contexts()[0];
await eventually(() => context.pages().length > 0, 'native WebView target was not created');
const first = context.pages()[0];
assert.ok(first, 'native WebView was not discovered');
const dir = path.resolve('artifacts/qa-native/fixtures');
await mkdir(dir, { recursive: true });
const checks = [];
async function check(name, run) {
  await run(); checks.push(name); console.log(`PASS ${name}`);
}
async function setup(page) {
  await page.waitForSelector('[role=toolbar]');
  await page.evaluate(() => {
    window.__qaImport = (path) => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path)?.name ?? path);
  });
}
async function ipc(page, name, args = []) {
  return page.evaluate(async ({ name, args }) => {
    if (name === 'writeFile') args[0] = new Uint8Array(args[0]);
    try { return await (await window.__qaImport('/src/ipc/index.ts')).ipc[name](...args); }
    catch (error) { throw new Error(JSON.stringify(error)); }
  }, { name, args });
}
async function command(page, id, args) {
  return page.evaluate(async ({ id, args }) => (await window.__qaImport('/src/core/commands.ts')).executeCommand(id, args), { id, args });
}
async function setting(page, key, value) {
  await page.evaluate(async ({ key, value }) => {
    const settings = await window.__qaImport('/src/core/settings.ts');
    settings.setSetting(key, value); await settings.flushSettings();
  }, { key, value });
}
async function active(page) {
  return page.evaluate(async () => {
    const tabs = await window.__qaImport('/src/editor/tabs.ts');
    const tab = tabs.activeTab();
    return tab && { id: tab.id, doc: tab.doc, text: tabs.tabText(tab) };
  });
}
async function eventually(fn, message, duration = 10000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
try {
  await setup(first);
  await check('native startup and Windows spelling API are reachable', async () => {
    assert.ok((await ipc(first, 'systemLocale')).length > 0);
    try { assert.ok((await ipc(first, 'spellCheck', [['hello', 'hellloooo']])).includes('hellloooo')); }
    catch (e) { if (!String(e).includes('unsupported')) throw e; console.log('English Windows spelling component unavailable'); }
  });
  const filename = path.join(dir, 'encoding.txt');
  await writeFile(filename, 'hello\r\n中文\r\n', 'utf8');
  await command(first, 'file.open', filename);
  await check('native read detects CRLF and UTF-8', async () => {
    const tab = await active(first);
    assert.equal(tab.text, 'hello\n中文\n');
    assert.equal(tab.doc.eol, 'CRLF');
    assert.equal(tab.doc.hasBom, false);
  });
  await check('encoding menu command writes UTF-16 BE BOM and bare CR bytes', async () => {
    await command(first, 'editor.setEol', 'CR');
    assert.equal(await command(first, 'file.saveWithEncoding', 'utf-16be-bom'), true);
    const bytes = await readFile(filename);
    assert.equal(bytes.subarray(0, 2).toString('hex'), 'feff');
    const swapped = Buffer.from(bytes.subarray(2)); swapped.swap16();
    assert.equal(swapped.toString('utf16le'), 'hello\r中文\r');
    await command(first, 'file.reload');
    assert.equal((await active(first)).text, 'hello\n中文\n');
    assert.equal((await active(first)).doc.eol, 'CR');
  });
  await check('unrepresentable encoding refuses to overwrite the original file', async () => {
    const before = await readFile(filename);
    await assert.rejects(() => ipc(first, 'writeFile', [[...new TextEncoder().encode('中文')], {
      path: filename, encoding: 'windows-1252', eol: 'LF', bom: false,
    }]), /unmappable|represent|转换|编码/i);
    assert.deepEqual(await readFile(filename), before);
  });
  await check('new window initializes and receives synchronized settings', async () => {
    await ipc(first, 'windowOpen', [{}]);
    await eventually(() => context.pages().length > 1, 'second native window was not created');
    const second = context.pages().find(p => p !== first);
    await setup(second);
    await setting(first, 'editor.lineNumbers', false);
    await eventually(() => second.evaluate(async () => !(await window.__qaImport('/src/core/settings.ts')).getSetting('editor.lineNumbers')), 'settings did not sync');
    await setting(second, 'editor.smartCopy', true);
    await eventually(() => first.evaluate(async () => (await window.__qaImport('/src/core/settings.ts')).getSetting('editor.smartCopy')), 'reverse settings did not sync');
    await setting(first, 'editor.lineNumbers', true);
  });
  await check('moving a dirty tab preserves text, metadata and selection before removing the source', async () => {
    await first.evaluate(async () => {
      const { getView } = await window.__qaImport('/src/editor/tabs.ts');
      const view = getView();
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'UNSAVED 草稿' }, selection: { anchor: 2, head: 5 } });
    });
    await command(first, 'editor.setLanguage', 'javascript');
    const before = await active(first);
    const previous = new Set(context.pages());
    assert.equal(await command(first, 'tab.moveToNewWindow', { id: before.id, x: 100, y: 100 }), true);
    const destination = context.pages().find(page => !previous.has(page));
    assert.ok(destination, 'transfer did not create a new WebView');
    await setup(destination);
    const after = await active(destination);
    assert.equal(after.text, before.text);
    for (const key of ['path', 'encoding', 'eol', 'hasBom', 'dirty']) assert.equal(after.doc[key], before.doc[key], key);
    assert.deepEqual(await destination.evaluate(async () => {
      const { activeTab, getView } = await window.__qaImport('/src/editor/tabs.ts');
      const range = getView().state.selection.main;
      return [activeTab().languageId, range.anchor, range.head];
    }), ['javascript', 2, 5]);
    assert.equal(await first.evaluate(async id => (await window.__qaImport('/src/editor/tabs.ts')).listTabs().some(tab => tab.id === id), before.id), false);
    await destination.screenshot({ path: 'artifacts/qa-native/transferred-draft.png' });
    await setting(destination, 'window.closeLastTabExits', true);
    await destination.evaluate(async () => { (await window.__qaImport('/src/ipc/index.ts')).ipc.confirm = async () => false; });
    await command(destination, 'tab.close');
    assert.equal(destination.isClosed(), false);
    assert.equal((await active(destination)).text, before.text);
    await destination.evaluate(async () => { (await window.__qaImport('/src/ipc/index.ts')).ipc.confirm = async () => true; });
    await command(destination, 'tab.close');
    await eventually(() => destination.isClosed(), 'last tab did not close its native window');
    await setting(first, 'window.closeLastTabExits', false);
  });
  await check('always-new-window preference opens each selected file in a separate native window', async () => {
    const secondFile = path.join(dir, 'second.txt');
    const thirdFile = path.join(dir, 'third.txt');
    await writeFile(secondFile, 'second'); await writeFile(thirdFile, 'third');
    await setting(first, 'window.openFilesInNewWindow', true);
    const count = context.pages().length;
    await command(first, 'file.open', { paths: [secondFile, thirdFile] });
    await eventually(() => context.pages().length === count + 2, 'multiple selected files did not open separate windows');
    for (const page of context.pages()) await setup(page);
    await setting(first, 'window.openFilesInNewWindow', false);
  });
  await check('quit vote blocks commands and existing palette, then cancellation restores every window', async () => {
    const pages = context.pages();
    for (const page of pages) {
      await command(page, 'file.new');
      await page.evaluate(async () => {
        const { getView } = await window.__qaImport('/src/editor/tabs.ts');
        getView().dispatch({ changes: { from: 0, insert: 'quit confirmation draft' } });
        (await window.__qaImport('/src/ipc/index.ts')).ipc.confirm = async () => true;
      });
    }
    const accepted = pages.find(page => page !== first);
    await command(accepted, 'palette.open');
    assert.equal(await accepted.locator('.palette-overlay').count(), 1);
    await first.evaluate(async () => {
      (await window.__qaImport('/src/ipc/index.ts')).ipc.confirm = () => new Promise(resolve => { window.__qaQuitResolve = resolve; });
    });
    await command(first, 'app.quit');
    await eventually(() => first.evaluate(() => typeof window.__qaQuitResolve === 'function'), 'quit confirmation did not begin');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(await accepted.evaluate(() => window.document.getElementById('app').inert), true);
    assert.equal(await accepted.locator('.palette-overlay').count(), 0);
    const count = await accepted.evaluate(async () => (await window.__qaImport('/src/editor/tabs.ts')).listTabs().length);
    await accepted.keyboard.press('Control+n');
    await command(accepted, 'file.new');
    assert.equal(await accepted.evaluate(async () => (await window.__qaImport('/src/editor/tabs.ts')).listTabs().length), count);
    await first.evaluate(() => window.__qaQuitResolve(false));
    await eventually(async () => !(await accepted.evaluate(() => window.document.getElementById('app').inert)), 'cancelled quit did not release the accepted window');
    assert.equal(context.pages().length, pages.length);
    for (const page of pages) {
      assert.equal((await active(page)).text, 'quit confirmation draft');
      assert.equal(await page.evaluate(() => window.document.getElementById('app').inert), false);
    }
    await command(accepted, 'file.new');
    assert.equal(await accepted.evaluate(async () => (await window.__qaImport('/src/editor/tabs.ts')).listTabs().length), count + 1);
  });
  await first.screenshot({ path: 'artifacts/qa-native/native-editor.png' });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  for (const page of context.pages()) {
    if (!page.isClosed()) await page.evaluate(async () => (await window.__qaImport('/src/ipc/index.ts')).ipc.window.destroy()).catch(() => {});
  }
  await browser.close();
}
