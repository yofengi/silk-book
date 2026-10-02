/* global console, process, window, document, setTimeout */
// Real signed GitHub download in a disposable older-version native client.
// All quit approvals are forcibly refused by this test: it never starts an installer.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

const { chromium } = createRequire(import.meta.url)(process.env.QA_PLAYWRIGHT || 'playwright');
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = path.resolve(process.env.QA_EXECUTABLE || 'artifacts/update-qa-client/boshu.exe');
assert.ok(executable.startsWith(path.resolve('artifacts') + path.sep), 'Use a disposable QA client, never the installed executable');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const output = path.resolve(`artifacts/qa-background-update-${Date.now()}`);
const checks = [];
let child, browser, context, page;

async function eventually(fn, message, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) return; await sleep(100); }
  throw new Error(message);
}
async function invoke(target, command, args = {}) {
  return target.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
async function guard(target) {
  await target.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__qaInstallVoteCount = 0;
    window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
      if (command === 'app_quit_reply') {
        window.__qaInstallVoteCount++;
        return original(command, { ...args, allow: false }, options);
      }
      if (command === 'plugin:dialog|confirm') return Promise.resolve(false);
      return original(command, args, options);
    };
  });
}
async function launch() {
  const running = await exec('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process boshu -ErrorAction SilentlyContinue).Count'], { windowsHide: true });
  assert.equal(Number(running.stdout.trim()), 0, 'Preserve existing Boshu processes');
  const listening = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 9223 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  assert.equal(listening, false, 'Preserve existing debugger listeners');
  child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, APPDATA: path.join(output, 'appdata'), WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
  } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await eventually(async () => { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9223'); return true; } catch { return false; } }, 'CDP missing');
  context = browser.contexts()[0];
  await eventually(() => context.pages().length > 0, 'Native page missing');
  page = context.pages()[0];
  await page.waitForFunction(() => document.documentElement.dataset.startup === 'ready');
  assert.equal((await invoke(page, 'updates_info')).currentVersion, '0.1.99', 'Use the separate 0.1.99 QA build');
  await guard(page);
}
async function closeOwned() {
  if (context) {
    for (const target of context.pages()) {
      // Fixture-only windows may have dirty text. Destroy only this owned isolated process's windows.
      await invoke(target, 'plugin:window|destroy', { label: await target.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label) }).catch(() => {});
    }
  }
  await browser?.close().catch(() => {});
  browser = context = undefined;
  if (child && child.exitCode === null) await eventually(() => child.exitCode !== null, 'Owned QA process failed to close').catch(() => child.kill());
  child = undefined;
}
async function about(target) {
  await target.keyboard.press('Control+,');
  await target.getByRole('tab', { name: '关于', exact: true }).click();
}
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }

try {
  await mkdir(path.join(output, 'appdata/Boshu'), { recursive: true });
  await writeFile(path.join(output, 'appdata/Boshu/settings.json'), JSON.stringify({
    'workbench.language': 'zh-CN', 'workbench.theme': 'glass-dark',
    'updates.lastCheckedAt': Date.now(), 'updates.intervalHours': 720, 'updates.manualMode': 'download-and-install',
  }));
  await launch();
  await about(page);
  await check('real GitHub release starts a shared background transfer', async () => {
    assert.equal((await invoke(page, 'updates_transfer')).phase, 'idle', 'Build the QA client with a fresh isolated cache path');
    const result = await invoke(page, 'updates_check', { manual: true });
    assert.equal(result.status, 'available');
    assert.equal(result.release.version, version);
    await invoke(page, 'window_open', { opts: {} });
    await eventually(() => context.pages().length === 2, 'Second window missing');
    const second = context.pages().find(candidate => candidate !== page);
    await second.waitForFunction(() => document.documentElement.dataset.startup === 'ready');
    await guard(second);
    const first = await invoke(page, 'updates_download', { version, mode: 'download-and-install' });
    const repeated = await invoke(second, 'updates_download', { version, mode: 'download-only' });
    assert.equal(first.taskId, repeated.taskId);
    assert.equal(repeated.mode, 'download-and-install');
    await second.keyboard.press('Control+n');
    await second.locator('.cm-content').click();
    await second.keyboard.insertText('Editable during a background update');
    assert.match(await second.locator('.cm-content').innerText(), /Editable during a background update/);
    const progress = [];
    await eventually(async () => {
      const state = await invoke(page, 'updates_transfer');
      progress.push({ revision: state.revision, phase: state.phase, bytes: state.downloadedBytes, total: state.totalBytes });
      assert.notEqual(state.phase, 'error', JSON.stringify(state.error));
      return state.phase === 'ready';
    }, 'Signed package download did not finish', 600000);
    assert.ok(progress.some(value => value.bytes > 0));
    for (let index = 1; index < progress.length; index++) {
      assert.ok(progress[index].revision >= progress[index - 1].revision);
      assert.ok(progress[index].bytes >= progress[index - 1].bytes);
    }
    await writeFile(path.join(output, 'download-progress.json'), JSON.stringify(progress, null, 2));
    assert.equal((await invoke(second, 'updates_transfer')).taskId, first.taskId);
    await page.locator('.update-panel').getByRole('button', { name: '安装并重启', exact: true }).waitFor();
    assert.equal(await second.locator('.update-panel').count(), 0, 'Only initiator displays completion popup');
    await page.screenshot({ path: path.join(output, 'download-ready.png') });
  });
  await check('cancelled native installation vote keeps the package and every window usable', async () => {
    // The installed test guard refuses every vote even if a frontend regression approves.
    await page.locator('.update-panel').getByRole('button', { name: '安装并重启', exact: true }).click();
    await eventually(async () => (await page.evaluate(() => window.__qaInstallVoteCount)) > 0, 'Native vote did not reach frontend');
    await eventually(async () => (await invoke(page, 'updates_transfer')).phase === 'ready', 'Cancelled vote did not restore ready');
    await eventually(async () => (await Promise.all(context.pages().map(target => target.evaluate(() => document.body.inert)))).every(value => !value), 'Cancelled vote did not unfreeze all windows');
    assert.equal(context.pages().length, 2);
    const second = context.pages().find(candidate => candidate !== page);
    assert.match(await second.locator('.cm-content').innerText(), /Editable during a background update/);
  });
  await check('verified cache restores after restart without re-downloading or repeating the popup', async () => {
    const before = await invoke(page, 'updates_transfer');
    await closeOwned();
    await launch();
    const after = await invoke(page, 'updates_transfer');
    assert.equal(after.phase, 'ready');
    assert.equal(after.release.version, version);
    assert.equal(after.downloadedBytes, before.downloadedBytes);
    assert.equal(after.mode, 'download-and-install');
    assert.notEqual(after.taskId, before.taskId);
    assert.equal(await page.locator('.update-panel').count(), 0);
    await about(page);
    await page.locator('.st-about').getByRole('button', { name: '安装并重启', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'restored-ready.png') });
  });
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, version }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally { await closeOwned(); }
