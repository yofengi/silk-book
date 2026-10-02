/* global console, process, window, setTimeout */
// Native release/setting smoke test. Uses only its own process and an isolated profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
const exec = promisify(execFile);
const dir = path.resolve(`artifacts/qa-publishing-${Date.now()}`);
const executable = path.resolve(process.env.QA_EXECUTABLE || `src-tauri/target/${process.env.QA_RELEASE ? 'release' : 'debug'}/boshu.exe`);
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const expectedAppVersion = process.env.QA_APP_VERSION || packageVersion;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, context, page;
const errors = [];
const checks = [];

async function eventually(fn, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(100); }
  throw new Error(message);
}
async function invoke(target, command, args = {}) {
  return target.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
async function launch() {
  const running = await exec('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process boshu -ErrorAction SilentlyContinue).Count'], { windowsHide: true });
  assert.equal(Number(running.stdout.trim()), 0, 'Preserve any existing Boshu process; close prior isolated QA first');
  const child = spawn(executable, [], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, APPDATA: path.join(dir, 'appdata'), WEBVIEW2_USER_DATA_FOLDER: path.join(dir, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223' },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  await eventually(async () => {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9223'); return true; } catch { return false; }
  }, 'CDP did not become available');
  context = browser.contexts()[0];
  await eventually(() => context.pages().length > 0, 'native window missing');
  page = context.pages()[0];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('[role=toolbar]');
  // v0.1.0 predates the handshake; newer windows mount their DOM while still hidden.
  if (expectedAppVersion !== '0.1.0') {
    await page.waitForFunction(() => window.document.documentElement.dataset.startup === 'ready');
  }
}
async function closeAll() {
  if (!context) return;
  for (const target of context.pages()) {
    if (target.isClosed()) continue;
    await invoke(target, 'plugin:window|close', { label: await target.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label) }).catch(() => {});
  }
  await sleep(700);
  await browser?.close().catch(() => {});
  browser = context = undefined;
}
const size = target => target.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }

try {
  await mkdir(path.join(dir, 'appdata/Boshu'), { recursive: true });
  await writeFile(path.join(dir, 'appdata/Boshu/window-state.json'), JSON.stringify({ version: 1, width: 916, height: 612, maximized: false }));
  await writeFile(path.join(dir, 'appdata/Boshu/settings.json'), JSON.stringify({ 'workbench.language': 'zh-CN', 'updates.lastCheckedAt': Date.now(), 'updates.intervalHours': 720 }));
  await launch();
  await check('window size is remembered by default', async () => {
    assert.deepEqual(await size(page), { width: 916, height: 612 });
    await page.keyboard.press('Control+,');
    await page.getByRole('switch', { name: '记住窗口大小', exact: true }).waitFor();
    assert.equal(await page.getByRole('switch', { name: '记住窗口大小', exact: true }).getAttribute('aria-checked'), 'true');
  });
  await check('General toggle is persisted and About follows keyboard shortcuts', async () => {
    await page.getByRole('switch', { name: '记住窗口大小', exact: true }).click();
    await eventually(async () => (await invoke(page, 'read_settings'))['window.rememberSize'] === false, 'size switch was not saved');
    const navigation = await page.locator('.st-nav [role=tab]').allTextContents();
    assert.equal(navigation.at(-1), '关于');
    assert.equal(navigation.at(-2), '快捷键');
    await page.getByRole('tab', { name: '关于', exact: true }).click();
    assert.ok((await page.locator('.st-content').innerText()).includes(expectedAppVersion));
    await page.screenshot({ path: path.join(dir, 'about.png') });
  });
  await check('disabled size memory resets startup and new windows to default dimensions', async () => {
    await closeAll(); await launch();
    assert.deepEqual(await size(page), { width: 1000, height: 700 });
    await invoke(page, 'window_open', { opts: {} });
    await eventually(() => context.pages().length === 2, 'second window missing');
    const second = context.pages().find(target => target !== page);
    await second.waitForSelector('[role=toolbar]');
    assert.deepEqual(await size(second), { width: 1000, height: 700 });
  });
  if (process.env.QA_EXPECT_RELEASE) await check('published GitHub release matches the expected current or available state', async () => {
    const info = await invoke(page, 'updates_info');
    assert.equal(info.repositoryUrl, 'https://github.com/yofengi/silk-book');
    assert.equal(info.currentVersion, expectedAppVersion);
    const result = await invoke(page, 'updates_check', { manual: true });
    assert.equal(result.status, process.env.QA_EXPECT_UPDATE ? 'available' : 'current');
    assert.equal(result.release.version, packageVersion);
    assert.ok(result.release.asset.url.endsWith(`/silk-book-${packageVersion}-windows-x64-setup.exe`));
    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: '关于', exact: true }).click();
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    if (process.env.QA_EXPECT_UPDATE) {
      await page.locator('.st-about').getByText(`新版本 ${packageVersion}`, { exact: true }).waitFor({ timeout: 35000 });
      await page.locator('.tb-update').click();
      await page.locator('.update-panel').getByRole('button', { name: '下载更新', exact: true }).waitFor();
      await page.locator('.update-panel').getByRole('button', { name: '忽略这次更新', exact: true }).waitFor();
      assert.ok(result.release.notes.trim().length > 0);
      assert.equal(await page.locator('.update-notes').innerText(), result.release.notes);
    } else {
      await page.getByText('当前已是最新版本。', { exact: true }).waitFor({ timeout: 35000 });
    }
    await page.screenshot({ path: path.join(dir, 'about-release.png') });
    console.log(`LIVE RELEASE ${JSON.stringify({ status: result.status, version: result.release.version, asset: result.release.asset.name })}`);
  });
  await check('no uncaught frontend exceptions', () => assert.deepEqual(errors, []));
  await writeFile(path.join(dir, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output: dir }));
} finally { await closeAll(); }
