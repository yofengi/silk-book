/* global console, process, window, document, setTimeout */
// Real signed GitHub download in a disposable older-version native client.
// This local test never requests installation. Native installation is exercised
// only by qa-windows-installer.ps1 on a disposable GitHub Actions runner.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifactRoot = path.resolve('artifacts');
const physicalArtifactRoot = await realpath(artifactRoot);
assert.equal(path.relative(artifactRoot, physicalArtifactRoot), '', 'Artifacts must be a physical workspace directory');
const executable = path.resolve(process.env.QA_EXECUTABLE || 'artifacts/update-qa-client/boshu.exe');
const qaConfigPath = path.join(path.dirname(executable), 'tauri.qa.json');
// Attestation of this separately built 0.1.99 client, including its unique
// identifier and artifact cache override. Rebuilds require a reviewed new hash.
const expectedQaHash = 'fea058f1e57d421059e864f92f4b8da3bc786ebee0f6f1ef4f8c79875e622511';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const output = path.resolve(`artifacts/qa-background-update-${Date.now()}`);
const resumeReady = process.argv.includes('--resume-ready');
const checks = [];
let child, browser, context, page;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
async function artifactPath(candidate, description) {
  const absolute = path.resolve(candidate);
  assert.ok(inside(artifactRoot, absolute), `${description} must stay strictly inside artifacts`);
  let existing = absolute;
  const missing = [];
  for (;;) {
    try { await lstat(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  const physical = path.resolve(await realpath(existing), ...missing);
  assert.ok(inside(physicalArtifactRoot, physical), `${description} must not escape artifacts through a link`);
  return physical;
}
async function validateQaBuild() {
  await artifactPath(executable, 'QA executable');
  await artifactPath(qaConfigPath, 'QA configuration');
  const qa = JSON.parse(await readFile(qaConfigPath, 'utf8'));
  const production = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(qa.version, '0.1.99', 'Use the older disposable QA build');
  assert.equal(qa.identifier, 'com.boshu.editor.update-qa', 'Use the reviewed QA single-instance identifier');
  assert.notEqual(qa.identifier, production.identifier, 'QA must not forward startup to the installed application');
  const cache = qa.app?.appDirectoriesOverride?.cache;
  assert.ok(typeof cache === 'string' && path.isAbsolute(cache), 'QA must declare an absolute isolated cache override');
  const physicalCache = await artifactPath(cache, 'QA cache');
  await artifactPath(output, 'QA output/profile');
  assert.equal(createHash('sha256').update(await readFile(executable)).digest('hex'), expectedQaHash,
    'QA executable must match the reviewed separate-identifier/cache build, never a copied production binary');
  return { identifier: qa.identifier, cache: physicalCache };
}
async function refuseExisting() {
  await validateQaBuild();
  const running = await exec('powershell.exe', ['-NoProfile', '-Command',
    "@((Get-Process boshu -ErrorAction SilentlyContinue) | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $env:BOSHU_QA_EXPECTED_EXECUTABLE }).Count"],
  { windowsHide: true, env: { ...process.env, BOSHU_QA_EXPECTED_EXECUTABLE: executable } });
  assert.equal(Number(running.stdout.trim()), 0, 'Preserve any existing instance of this exact QA executable');
  const listening = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 9223 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  assert.equal(listening, false, 'Preserve existing debugger listeners');
}

async function eventually(fn, message, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) return; await sleep(100); }
  throw new Error(message);
}
async function invoke(target, command, args = {}) {
  return target.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
async function blockInstallClicks(target) {
  await target.evaluate(() => {
    // Prevent accidental clicks while the isolated test windows are visible.
    // Tauri's native invoke is non-writable; do not pretend to monkey-patch it.
    document.addEventListener('click', event => {
      const button = event.target.closest?.('button');
      if (button && ['安装更新', '安装并重启'].includes(button.textContent.trim())) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  });
}
async function launch() {
  await refuseExisting();
  const qa = await validateQaBuild();
  const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
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
  assert.equal(await invoke(page, 'plugin:app|identifier'), qa.identifier, 'The running binary must retain its isolated identifier');
  const runningCache = await invoke(page, 'plugin:path|resolve_directory', { directory: 16 });
  assert.equal(path.relative(qa.cache, await artifactPath(runningCache, 'Running QA cache')), '', 'The running binary must retain its isolated cache override');
  assert.equal((await invoke(page, 'updates_info')).currentVersion, '0.1.99', 'Use the separate 0.1.99 QA build');
  await blockInstallClicks(page);
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
async function check(name, fn) {
  try { await fn(); checks.push(name); console.log(`PASS ${name}`); }
  catch (error) {
    const windows = await Promise.all((context?.pages() ?? []).map(target => target.evaluate(() => ({
      label: window.__TAURI_INTERNALS__.metadata.currentWindow.label, inert: document.body.inert,
    })).catch(failure => ({ error: failure.message }))));
    await writeFile(path.join(output, 'failure.json'), JSON.stringify({ name, error: error.message, windows }, null, 2));
    console.log(JSON.stringify({ failed: name, windows, output }));
    throw error;
  }
}

if (process.argv.includes('--preflight-only')) {
  await refuseExisting();
  console.log('PASS reviewed QA executable/config/cache isolation, exact-path process guard, and unused debugger port; no application launched');
  process.exit(0);
}

try {
  await validateQaBuild();
  await mkdir(path.join(output, 'appdata/Boshu'), { recursive: true });
  await writeFile(path.join(output, 'appdata/Boshu/settings.json'), JSON.stringify({
    'workbench.language': 'zh-CN', 'workbench.theme': 'glass-dark',
    'updates.lastCheckedAt': Date.now(), 'updates.intervalHours': 720, 'updates.manualMode': 'download-and-install',
  }));
  await launch();
  await about(page);
  await check(resumeReady ? 'verified signed cache resumes a shared ready transfer' : 'real GitHub release starts a shared background transfer', async () => {
    const initial = await invoke(page, 'updates_transfer');
    assert.equal(initial.phase, resumeReady ? 'ready' : 'idle', 'Use a fresh isolated cache, or explicitly resume its verified ready package');
    if (resumeReady) {
      assert.equal(initial.release.version, version);
      assert.ok(initial.downloadedBytes > 0);
      assert.equal(await page.locator('.update-panel').count(), 0, 'Cache restore must not repeat the completion popup');
    }
    const result = await invoke(page, 'updates_check', { manual: true });
    assert.equal(result.status, 'available');
    assert.equal(result.release.version, version);
    await invoke(page, 'window_open', { opts: {} });
    await eventually(() => context.pages().length === 2, 'Second window missing');
    const second = context.pages().find(candidate => candidate !== page);
    await second.waitForFunction(() => document.documentElement.dataset.startup === 'ready');
    await blockInstallClicks(second);
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
    if (resumeReady) await page.locator('.tb-update').click();
    await page.locator('.update-panel').getByRole('button', { name: '安装并重启', exact: true }).waitFor();
    assert.equal(await second.locator('.update-panel').count(), 0, 'Only initiator displays completion popup');
    await page.screenshot({ path: path.join(output, 'download-ready.png') });
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
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, version, resumeReady }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally { await closeOwned(); }
