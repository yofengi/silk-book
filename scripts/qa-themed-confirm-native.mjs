/* global console, process, window, document, setTimeout, getComputedStyle */
// Run only after building the separate dialog QA client. No installer or update
// commands, no native invoke replacement, and no control of user Boshu processes.
// QA_EXPECTED_SHA256 must be the reviewed SHA256 of that separate build.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifactRoot = path.resolve('artifacts');
const physicalRoot = await realpath(artifactRoot);
assert.equal(path.relative(artifactRoot, physicalRoot), '', 'Artifacts must be a physical workspace directory');
const executable = path.resolve(process.env.QA_EXECUTABLE || 'artifacts/dialog-qa-client/boshu.exe');
const configPath = path.join(path.dirname(executable), 'tauri.qa.json');
const output = path.join(artifactRoot, `qa-themed-confirm-${Date.now()}-${randomUUID()}`);
const appdata = path.join(output, 'appdata');
const webview = path.join(output, 'webview');
const selector = 'dialog.confirm-dialog[open]';
const expectedVersion = '0.2.1';
const expectedIdentifier = 'com.boshu.editor.dialog-qa';
const expectedHash = process.env.QA_EXPECTED_SHA256?.toLowerCase();
const checks = [], evidence = [], errors = [];
const ownedPages = new Set();
let child, browser, context;

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
  assert.ok(inside(physicalRoot, physical), `${description} must not escape artifacts through a link`);
  return physical;
}
async function validateBuild() {
  await artifactPath(executable, 'QA executable');
  await artifactPath(configPath, 'QA config');
  for (const [candidate, description] of [[output, 'QA output'], [appdata, 'QA profile'], [webview, 'QA WebView profile']]) {
    await artifactPath(candidate, description);
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const production = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(config.version, expectedVersion);
  assert.equal(config.identifier, expectedIdentifier);
  assert.notEqual(config.identifier, production.identifier, 'QA must not forward startup to the installed application');
  const cache = config.app?.appDirectoriesOverride?.cache;
  assert.ok(typeof cache === 'string' && path.isAbsolute(cache), 'QA needs an absolute cache override');
  const physicalCache = await artifactPath(cache, 'QA cache');
  assert.ok(inside(path.dirname(await realpath(executable)), physicalCache), 'QA cache must belong to the separate client directory');
  assert.match(expectedHash ?? '', /^[a-f0-9]{64}$/, 'Set QA_EXPECTED_SHA256 to the reviewed separate QA build hash');
  assert.equal(createHash('sha256').update(await readFile(executable)).digest('hex'), expectedHash,
    'QA binary must match the reviewed identifier/cache build');
  return { cache: physicalCache, sha256: expectedHash };
}
async function preflight() {
  const build = await validateBuild();
  const existing = await exec('powershell.exe', ['-NoProfile', '-Command',
    "@((Get-Process boshu -ErrorAction SilentlyContinue) | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $env:BOSHU_DIALOG_QA_EXECUTABLE }).Count"],
  { windowsHide: true, env: { ...process.env, BOSHU_DIALOG_QA_EXECUTABLE: executable } });
  assert.equal(Number(existing.stdout.trim()), 0, 'Preserve any already running instance of this exact QA executable');
  const listening = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 9223 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  assert.equal(listening, false, 'Port 9223 is occupied; do not attach to another browser');
  return build;
}
async function eventually(predicate, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(50); }
  throw new Error(message);
}
// This allowlist is deliberately limited to this harness's exit/settings checks.
const allowedCommands = new Set([
  'plugin:app|identifier', 'plugin:app|version', 'plugin:path|resolve_directory',
  'read_settings', 'write_settings', 'window_open', 'app_request_quit', 'plugin:window|destroy',
]);
async function invoke(target, command, args = {}) {
  assert.ok(allowedCommands.has(command), `Native QA command is outside the allowlist: ${command}`);
  return target.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
async function verifyPage(target, build) {
  await target.waitForFunction(() => document.documentElement.dataset.startup === 'ready');
  assert.equal(await invoke(target, 'plugin:app|identifier'), expectedIdentifier);
  assert.equal(await invoke(target, 'plugin:app|version'), expectedVersion);
  const actualCache = await invoke(target, 'plugin:path|resolve_directory', { directory: 16 });
  assert.equal(path.relative(build.cache, await artifactPath(actualCache, 'Running QA cache')), '');
  ownedPages.add(target);
  target.on('pageerror', error => errors.push(error.message));
}
async function launch(build) {
  const { chromium } = createRequire(import.meta.url)(process.env.QA_PLAYWRIGHT || 'playwright');
  child = spawn(executable, [], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env, APPDATA: appdata, WEBVIEW2_USER_DATA_FOLDER: webview,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
    },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error('Owned QA process exited before debugger connection');
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9223'); return true; } catch { return false; }
  }, 'Owned QA debugger did not become available');
  context = browser.contexts()[0];
  await eventually(() => context.pages().length === 1, 'Exactly one initial QA window is required');
  const first = context.pages()[0];
  await verifyPage(first, build);
  return first;
}
async function snapshot(target) {
  return target.evaluate(() => {
    const dialog = document.querySelector('dialog.confirm-dialog[open]');
    const css = dialog ? getComputedStyle(dialog) : null;
    return {
      label: window.__TAURI_INTERNALS__.metadata.currentWindow.label,
      bodyInert: document.body.inert, theme: document.documentElement.dataset.theme,
      glass: document.documentElement.hasAttribute('data-glass'),
      text: document.querySelector('.cm-content')?.textContent,
      dialog: dialog ? {
        modal: dialog.matches(':modal'), role: dialog.getAttribute('role'),
        title: dialog.querySelector('.confirm-dialog-title')?.textContent,
        message: dialog.querySelector('.confirm-dialog-message')?.textContent,
        focusedCancel: document.activeElement === dialog.querySelector('.confirm-dialog-cancel'),
        background: css.backgroundColor, color: css.color, borderRadius: css.borderRadius,
      } : null,
    };
  });
}
async function record(name, pages, screenshots = true) {
  const windows = [];
  for (let index = 0; index < pages.length; index++) {
    windows.push(await snapshot(pages[index]));
    if (screenshots) await pages[index].screenshot({ path: path.join(output, `${name}-${index + 1}.png`) });
  }
  evidence.push({ name, windows });
}
async function modal(target, inert) {
  await target.locator(selector).waitFor({ state: 'visible' });
  const state = await snapshot(target);
  assert.equal(state.dialog.modal, true, 'Confirmation must use the real browser top layer');
  assert.equal(state.dialog.role, 'alertdialog');
  assert.equal(state.dialog.focusedCancel, true, 'Default focus must be Cancel');
  if (inert !== undefined) assert.equal(state.bodyInert, inert);
}
async function assertEditable(target, before, suffix) {
  await eventually(async () => !(await target.evaluate(() => document.body.inert)) && await target.locator(selector).count() === 0,
    'Cancellation must remove the modal and restore interaction');
  assert.match(await target.locator('.cm-content').innerText(), new RegExp(before));
  await target.locator('.cm-content').click();
  await target.keyboard.press('Control+End');
  await target.keyboard.insertText(suffix);
  assert.ok((await target.locator('.cm-content').innerText()).includes(before + suffix), 'Editor must accept a new edit after cancellation');
}
async function check(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`); }
async function closeOwned() {
  // Only verified pages from this QA context are destroyed. Never enumerate or
  // stop user processes; the sole process fallback is our own spawn handle.
  for (const target of ownedPages) {
    if (target.isClosed()) continue;
    const label = await target.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label).catch(() => null);
    if (label) await invoke(target, 'plugin:window|destroy', { label }).catch(() => {});
  }
  if (ownedPages.size) await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    await eventually(() => child.exitCode !== null, 'Owned QA process did not exit after cleanup', 5000).catch(() => child.kill());
  }
}

const build = await preflight();
if (process.argv.includes('--preflight-only')) {
  console.log(JSON.stringify({ preflight: 'passed', executable, sha256: build.sha256, cache: build.cache }));
  process.exit(0);
}
await mkdir(path.join(appdata, 'Boshu'), { recursive: true });
await mkdir(webview, { recursive: true });
await artifactPath(appdata, 'Created QA profile');
await artifactPath(webview, 'Created QA WebView profile');
await writeFile(path.join(appdata, 'Boshu/settings.json'), JSON.stringify({
  'workbench.language': 'en', 'workbench.theme': 'glass-dark',
  'updates.autoDownload': false, 'updates.lastCheckedAt': Date.now(), 'updates.intervalHours': 720,
}));
try {
  const first = await launch(build);
  const firstText = 'DIALOG_QA_FIRST_DRAFT';
  await first.keyboard.press('Control+n');
  await first.locator('.cm-content').click();
  await first.keyboard.insertText(firstText);
  await check('dirty tab close uses a themed modal and Cancel keeps the draft', async () => {
    await first.keyboard.press('Control+w');
    await modal(first);
    await record('tab-cancel', [first]);
    await first.locator('button.confirm-dialog-cancel').click();
    await assertEditable(first, firstText, '_AFTER_TAB_CANCEL');
  });
  let currentFirst = firstText + '_AFTER_TAB_CANCEL';
  await check('Escape cancels dirty tab close and preserves its text', async () => {
    await first.keyboard.press('Control+w');
    await modal(first);
    await first.keyboard.press('Escape');
    await assertEditable(first, currentFirst, '_AFTER_ESCAPE');
  });
  currentFirst += '_AFTER_ESCAPE';
  await invoke(first, 'window_open', { opts: {} });
  await eventually(() => context.pages().length === 2, 'Second QA window is missing');
  const second = context.pages().find(target => target !== first);
  await verifyPage(second, build);
  const secondText = 'DIALOG_QA_SECOND_DRAFT';
  await second.keyboard.press('Control+n');
  await second.locator('.cm-content').click();
  await second.keyboard.insertText(secondText);
  for (const theme of ['glass-dark', 'light', 'dark']) {
    await check(`${theme} follows isolated settings broadcasts in both windows`, async () => {
      const settings = await invoke(first, 'read_settings');
      await invoke(first, 'write_settings', { settingsValue: { ...settings, 'workbench.theme': theme } });
      await eventually(async () => (await Promise.all([first, second].map(snapshot))).every(state =>
        state.theme === (theme === 'light' ? 'light' : 'dark') && state.glass === theme.startsWith('glass-')),
      'Theme broadcast did not reach both isolated QA windows');
      await first.keyboard.press('Control+w');
      await modal(first);
      await record(`theme-${theme}`, [first]);
      await first.locator('button.confirm-dialog-cancel').click();
      await eventually(async () => await first.locator(selector).count() === 0, 'Theme screenshot dialog did not close');
      assert.ok((await first.locator('.cm-content').innerText()).includes(currentFirst));
    });
  }
  await check('one window cancels app quit while both inert windows have clickable top-layer modals', async () => {
    await invoke(first, 'app_request_quit');
    await Promise.all([first, second].map(target => modal(target, true)));
    await record('two-window-quit', [first, second]);
    // Real DOM click; never replace the native invoke bridge or approve a quit.
    await first.locator('button.confirm-dialog-cancel').click();
    await eventually(async () => (await Promise.all([first, second].map(snapshot))).every(state => !state.bodyInert && state.dialog === null),
      'Another window retained a stale confirmation or frozen editor after cancellation');
    assert.equal(context.pages().length, 2);
    await assertEditable(first, currentFirst, '_AFTER_QUIT_CANCEL');
    await assertEditable(second, secondText, '_AFTER_PEER_CANCEL');
    await record('two-window-cancelled', [first, second]);
  });
  currentFirst += '_AFTER_QUIT_CANCEL';
  await check('a second app quit opens fresh modals and Escape cancels both without losing drafts', async () => {
    await invoke(second, 'app_request_quit');
    await Promise.all([first, second].map(target => modal(target, true)));
    await second.keyboard.press('Escape');
    await eventually(async () => (await Promise.all([first, second].map(snapshot))).every(state => !state.bodyInert && state.dialog === null),
      'Repeated quit did not cancel both fresh dialogs');
    assert.equal(context.pages().length, 2);
    assert.ok((await first.locator('.cm-content').innerText()).includes(currentFirst));
    assert.ok((await second.locator('.cm-content').innerText()).includes(secondText + '_AFTER_PEER_CANCEL'));
    await record('repeat-quit-cancelled', [first, second]);
  });
  assert.deepEqual(errors, [], 'No uncaught frontend errors');
  await writeFile(path.join(output, 'results.json'), JSON.stringify({
    checks, evidence, errors, executable, sha256: build.sha256, identifier: expectedIdentifier, version: expectedVersion, cache: build.cache,
  }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} catch (error) {
  const windows = await Promise.all([...ownedPages].filter(target => !target.isClosed()).map(target => snapshot(target).catch(failure => ({ error: failure.message }))));
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ checks, evidence, error: error.message, windows, errors }, null, 2));
  console.log(JSON.stringify({ failed: error.message, output }));
  throw error;
} finally { await closeOwned(); }
