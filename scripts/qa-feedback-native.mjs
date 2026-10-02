/* global console, process, window, performance, URL, setTimeout */
// Run under the desktop account: uses only its own Boshu PID and isolated profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
const dir = 'artifacts/qa-feedback-native';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, context, first, pid;
const checks = [];
async function eventually(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(80); }
  throw new Error(message);
}
async function ps(script, args = []) {
  return (await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(script), ...args], { windowsHide: true })).stdout.trim();
}
async function native(action, args = {}) {
  return ps('scripts/native-window-qa.ps1', ['-Action', action, '-QaProcessId', String(pid), ...Object.entries(args).flatMap(([key, value]) => [`-${key}`, String(value)])]);
}
async function setup(page) {
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) console.log(`WEBVIEW ${message.type()}: ${message.text()}`); });
  page.on('pageerror', error => console.log(`WEBVIEW exception: ${error.message}`));
  await page.waitForSelector('[role=toolbar]');
  await page.evaluate(() => { window.__qaImport = p => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === p)?.name ?? p); });
}
async function launch() {
  const existing = await exec('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process boshu -ErrorAction SilentlyContinue).Count'], { windowsHide: true });
  assert.equal(Number(existing.stdout.trim()), 0, 'Keep any existing Boshu process intact; close the prior isolated test instance first');
  const child = spawn(path.resolve('src-tauri/target/debug/boshu.exe'), [], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, APPDATA: path.resolve(dir, 'appdata'), WEBVIEW2_USER_DATA_FOLDER: path.resolve(dir, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223' },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  pid = child.pid; child.unref();
  await writeFile(`${dir}/pid.txt`, String(pid));
  console.log(`Launched isolated native PID ${pid}`);
  await eventually(async () => {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9223'); return true; } catch { return false; }
  }, 'native CDP did not start');
  context = browser.contexts()[0];
  await eventually(() => context.pages().length > 0, 'no native page');
  first = context.pages()[0]; await setup(first);
}
async function command(page, id, args) {
  return page.evaluate(async ({ id, args }) => (await window.__qaImport('/src/core/commands.ts')).executeCommand(id, args), { id, args });
}
async function setting(page, key, value) {
  await page.evaluate(async ({ key, value }) => { const m = await window.__qaImport('/src/core/settings.ts'); m.setSetting(key, value); await m.flushSettings(); }, { key, value });
}
async function ipc(page, method, args = []) {
  return page.evaluate(async ({ method, args }) => (await window.__qaImport('/src/ipc/index.ts')).ipc[method](...args), { method, args });
}
async function tabs(page) {
  return page.evaluate(async () => {
    const m = await window.__qaImport('/src/editor/tabs.ts');
    const entries = m.listTabs();
    return m.allTabIds().flatMap(id => { const t = entries.find(tab => tab.id === id); return t ? [{ id: t.id, text: m.tabText(t), doc: t.doc, language: t.languageId }] : []; });
  });
}
async function fill(page, text) {
  await command(page, 'file.new');
  await page.evaluate(async text => { const v = (await window.__qaImport('/src/editor/tabs.ts')).getView(); v.dispatch({ changes: { from: 0, insert: text } }); }, text);
}
async function handle(page) {
  const origin = await page.evaluate(async () => (await window.__qaImport('/src/ipc/index.ts')).ipc.bus.innerOrigin());
  const windows = JSON.parse(await native('List'));
  windows.sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y));
  assert.ok(windows.length);
  return windows[0].handle;
}
async function screenPoint(page, local) {
  const o = await page.evaluate(async () => (await window.__qaImport('/src/ipc/index.ts')).ipc.bus.innerOrigin());
  return { x: Math.round(o.x + local.x * o.scale), y: Math.round(o.y + local.y * o.scale) };
}
async function size(page) { return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })); }
async function closeAll() {
  if (!context) return;
  for (const page of context.pages()) if (!page.isClosed()) await page.evaluate(async () => (await window.__qaImport('/src/ipc/index.ts')).ipc.window.destroy()).catch(() => {});
  await browser?.close().catch(() => {}); browser = context = undefined;
  await sleep(600);
}
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
try {
  await mkdir(dir, { recursive: true });
  await launch();
  await setting(first, 'window.closeLastTabExits', false);
  await setting(first, 'workbench.theme', 'glass-dark');
  if (await first.evaluate(async () => (await window.__qaImport('/src/ipc/index.ts')).ipc.window.isMaximized())) await command(first, 'window.toggleMaximize');
  await setting(first, 'editor.wordCompletion', false);
  await fill(first, '跨窗草稿 / unsaved 😀\nsecond line');
  await command(first, 'editor.find'); await command(first, 'menu.open');
  await first.screenshot({ path: `${dir}/native-glass-menu.png` });
  await first.keyboard.press('Escape');
  await first.locator('.cm-search [name=close]').click();
  await command(first, 'editor.setEol', 'CR');
  await command(first, 'editor.setLanguage', 'javascript');
  await first.evaluate(async () => { const v = (await window.__qaImport('/src/editor/tabs.ts')).getView(); v.dispatch({ selection: { anchor: 2, head: 7 } }); });
  const original = (await tabs(first))[0];
  await ipc(first, 'windowOpen', [{ x: 430, y: 25 }]);
  await eventually(() => context.pages().length === 2, 'destination window missing');
  const second = context.pages().find(p => p !== first); await setup(second);
  await fill(second, 'destination-left'); await fill(second, 'destination-right');
  const targetBefore = await tabs(second);
  const sourceHandle = await handle(first); const targetHandle = await handle(second);
  assert.notEqual(sourceHandle, targetHandle);
  await native('Resize', { WindowHandle: targetHandle, X: 430, Y: 25, Width: 760, Height: 580 });
  await native('Resize', { WindowHandle: sourceHandle, X: 20, Y: 300, Width: 700, Height: 420 });
  await sleep(350);
  if (!process.env.QA_GEOMETRY_ONLY) await check('physical mouse drag merges into an existing window at the drop position', async () => {
    await first.evaluate(() => {
      window.__qaPointer = [];
      for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'blur']) window.addEventListener(name, event => {
        window.__qaPointer.push({ event: name, x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY, target: event.target?.className });
      }, true);
    });
    const from = await first.locator(`.tabbar [data-tab-id="${original.id}"]`).boundingBox();
    const to = await second.locator(`.tabbar [data-tab-id="${targetBefore[1].id}"]`).boundingBox();
    const start = await screenPoint(first, { x: from.x + 22, y: from.y + from.height / 2 });
    const end = await screenPoint(second, { x: to.x + 3, y: to.y + to.height / 2 });
    await native('Raise', { WindowHandle: targetHandle });
    await native('Raise', { WindowHandle: sourceHandle });
    console.log(`Drag physical ${JSON.stringify({ start, end, sourceHandle, targetHandle })}`);
    console.log(await native('Drag', { WindowHandle: sourceHandle, X: start.x, Y: start.y, ToX: end.x, ToY: end.y }));
    try { await eventually(async () => (await tabs(second)).length === 3, 'physical drag did not merge the source tab'); }
    catch (error) {
      console.log(`POINTER ${JSON.stringify(await first.evaluate(() => window.__qaPointer))}`);
      console.log(`TABS ${JSON.stringify(await Promise.all(context.pages().map(tabs)))}`);
      throw error;
    }
    assert.equal(context.pages().length, 2, 'merge unexpectedly created a third window');
    await eventually(async () => (await tabs(first)).length === 0, 'source retained unchanged transferred tab');
    const merged = await tabs(second);
    assert.deepEqual(merged.map(tab => tab.text), ['destination-left', original.text, 'destination-right']);
    for (const key of ['path', 'encoding', 'hasBom', 'dirty', 'eol']) assert.equal(merged[1].doc[key], original.doc[key], key);
    assert.equal(merged[1].language, 'javascript');
    assert.deepEqual(await second.evaluate(async () => { const r = (await window.__qaImport('/src/editor/tabs.ts')).getView().state.selection.main; return [r.anchor, r.head]; }), [2, 7]);
    await second.screenshot({ path: `${dir}/merged-tabs.png` });
  });
  await first.evaluate(async () => (await window.__qaImport('/src/ipc/index.ts')).ipc.window.destroy()).catch(error => {
    if (!/closed/i.test(error.message)) throw error;
  });
  await native('Resize', { WindowHandle: targetHandle, X: 80, Y: 65, Width: 1090, Height: 730 });
  await sleep(350);
  const expected = await size(second);
  await check('normal window size survives a complete application restart', async () => {
    await closeAll(); await launch();
    assert.deepEqual(await size(first), expected);
  });
  await check('maximized restart preserves the previous normal restore size', async () => {
    await command(first, 'window.toggleMaximize');
    await eventually(() => first.evaluate(async () => (await window.__qaImport('/src/ipc/index.ts')).ipc.window.isMaximized()), 'did not maximize');
    await closeAll(); await launch();
    assert.equal(await first.evaluate(async () => (await window.__qaImport('/src/ipc/index.ts')).ipc.window.isMaximized()), true);
    await command(first, 'window.toggleMaximize');
    await sleep(300);
    console.log(`Restore size: ${JSON.stringify(await size(first))}; expected: ${JSON.stringify(expected)}`);
    await eventually(async () => JSON.stringify(await size(first)) === JSON.stringify(expected), 'normal size was overwritten while maximized');
  });
  await check('closing a minimized window does not replace the remembered normal size', async () => {
    await native('Minimize', { WindowHandle: await handle(first) });
    await sleep(250);
    await closeAll(); await launch();
    assert.deepEqual(await size(first), expected);
    assert.equal(await first.evaluate(async () => (await window.__qaImport('/src/ipc/index.ts')).ipc.window.isMaximized()), false);
  });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { await closeAll(); }
