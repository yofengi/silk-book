/* global console, process, window, document, performance, MutationObserver, setTimeout */
// Example: QA_EXECUTABLE=... QA_PLAYWRIGHT=... node scripts/qa-startup-native.mjs --baseline
// Records actual Win32 visibility before CDP attaches; late attachment cannot shift stored performance marks.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, access, rename } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';

const { chromium } = createRequire(import.meta.url)(process.env.QA_PLAYWRIGHT || 'playwright');
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseline = process.argv.includes('--baseline');
const executable = path.resolve(process.env.QA_EXECUTABLE || (baseline ? 'artifacts/previous-v0.1.0/boshu.exe' : 'src-tauri/target/release/boshu.exe'));
const expectedVersion = process.env.QA_APP_VERSION || (baseline ? '0.1.0' : JSON.parse(await readFile('package.json', 'utf8')).version);
const output = path.resolve(`artifacts/qa-startup-${baseline ? 'baseline' : 'fixed'}-${Date.now()}`);
const helper = path.resolve('scripts/qa-startup-native.ps1');
const scenarios = (process.env.QA_STARTUP_CASES || 'normal,remembered').split(',');
const openNewWindow = process.env.QA_STARTUP_NEW_WINDOW === '1';
const testTearOut = process.env.QA_STARTUP_TEAROUT === '1';
const reports = [];
let ownedChild, browser, observer;

async function eventually(fn, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(20); }
  throw new Error(message);
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
const ps = args => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, ...args], { windowsHide: true });
async function refuseExisting() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process boshu -ErrorAction SilentlyContinue).Count'], { windowsHide: true });
  assert.equal(Number(stdout.trim()), 0, 'Existing Boshu process must be left intact; refusing launch');
  const listening = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 9223 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  assert.equal(listening, false, 'Port 9223 is already in use; refusing to attach to another browser');
}
async function invoke(page, command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
async function collectFrontend(page, screenshot) {
  await eventually(async () => {
    try {
      return await page.evaluate(() => {
        if (!window.__TAURI_INTERNALS__ || document.URL === 'about:blank') return false;
        const ready = () => !!document.querySelector('#app [role=toolbar]') && !!document.querySelector('#app .cm-editor') && document.querySelector('#app').getBoundingClientRect().width > 0;
        window.__qaStartup = { observedAt: performance.timeOrigin + performance.now(), initiallyReady: ready(), domReadyAt: null };
        if (!window.__qaStartup.initiallyReady) {
          const observer = new MutationObserver(() => { if (ready()) { window.__qaStartup.domReadyAt = performance.timeOrigin + performance.now(); observer.disconnect(); } });
          observer.observe(document, { childList: true, subtree: true, attributes: true });
        }
        return true;
      });
    } catch { return false; } // CDP can attach before the initial WebView navigation completes.
  }, 'Frontend observation could not attach');
  await page.waitForSelector('#app .cm-editor');
  await page.waitForSelector('#app [role=toolbar]');
  if (!baseline) await page.waitForFunction(() => performance.getEntriesByName('startup:window-shown', 'mark').length > 0, undefined, { timeout: 15000, polling: 20 });
  await sleep(1200);
  const frontend = await page.evaluate(() => ({
    marks: performance.getEntriesByType('mark').map(entry => ({ name: entry.name, at: performance.timeOrigin + entry.startTime })),
    paints: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, at: performance.timeOrigin + entry.startTime })),
    dom: window.__qaStartup, width: window.innerWidth, height: window.innerHeight,
    title: document.title, collectedAt: performance.timeOrigin + performance.now(),
    label: window.__TAURI_INTERNALS__.metadata.currentWindow.label,
  }));
  frontend.version = (await invoke(page, 'updates_info')).currentVersion;
  assert.equal(frontend.version, expectedVersion, 'Executable version differs from the expected release');
  await page.screenshot({ path: screenshot });
  return frontend;
}
async function physicalTransfer(page, directory, ownedPid) {
  const nativeHelper = path.resolve('scripts/native-window-qa.ps1');
  const native = async args => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nativeHelper, '-QaProcessId', String(ownedPid), ...args], { windowsHide: true });
  const label = target => target.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  const origin = async target => {
    const targetLabel = await label(target);
    return { ...await invoke(target, 'plugin:window|inner_position', { label: targetLabel }), scale: await invoke(target, 'plugin:window|scale_factor', { label: targetLabel }) };
  };
  const hwnd = async target => {
    const outer = await invoke(target, 'plugin:window|outer_position', { label: await label(target) });
    const windows = JSON.parse((await native(['-Action', 'List'])).stdout);
    const owned = windows.filter(window => window.x === outer.x && window.y === outer.y);
    assert.equal(owned.length, 1, 'Physical drag requires one unambiguous owned HWND');
    return owned[0];
  };
  const point = async (target, locator) => {
    const rect = await locator.boundingBox();
    assert.ok(rect, 'Drag element missing');
    const position = await origin(target);
    return { x: Math.round(position.x + (rect.x + Math.min(rect.width * 0.4, 60)) * position.scale), y: Math.round(position.y + (rect.y + rect.height / 2) * position.scale) };
  };
  const drag = async (target, from, to) => {
    const handle = await hwnd(target);
    await native(['-Action', 'Raise', '-WindowHandle', String(handle.handle)]);
    const result = await native(['-Action', 'Drag', '-WindowHandle', String(handle.handle), '-X', String(from.x), '-Y', String(from.y), '-ToX', String(to.x), '-ToY', String(to.y)]);
    assert.equal(JSON.parse(result.stdout.trim()).hit, handle.handle, 'Physical mouse-down was outside the owned window');
    return handle;
  };
  const snapshot = async target => target.evaluate(() => ({
    text: [...document.querySelectorAll('.cm-content .cm-line')].map(line => line.textContent).join('\n'),
    path: document.querySelector('.tab.active')?.getAttribute('title'),
    dirty: document.querySelector('.tab.active')?.classList.contains('dirty'),
    selection: window.getSelection()?.toString(),
    tabCount: document.querySelectorAll('.tabbar .tab[data-tab-id]').length,
  }));
  const fixture = path.join(directory, 'transfer-fixture.txt');
  const content = 'STARTUP fixture 中文 🧵\nsecond line: preserved tab contents';
  await writeFile(fixture, content, 'utf8');
  await page.keyboard.press('Control+n');
  await eventually(async () => await page.locator('.tabbar .tab').count() === 1, 'Blank source tab missing');
  await invoke(page, 'plugin:event|emit_to', { target: { kind: 'WebviewWindow', label: await label(page) }, event: 'open-files', payload: [fixture] });
  await eventually(async () => (await snapshot(page)).text === content, 'Fixture did not open in the source');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+End');
  const before = await snapshot(page);
  assert.equal(before.path, fixture);
  assert.equal(before.dirty, false);
  assert.equal(before.tabCount, 2);
  assert.equal(before.selection, content.split('\n')[0]);
  const prior = new Set(browser.contexts()[0].pages());
  const sourceWindow = await hwnd(page);
  const from = await point(page, page.locator('.tab.active'));
  const to = { x: sourceWindow.x + sourceWindow.width + 120, y: sourceWindow.y + 200 };
  const openedAt = Date.now();
  await drag(page, from, to);
  let detached;
  await eventually(() => { detached = browser.contexts()[0].pages().find(target => !prior.has(target)); return !!detached; }, 'Physical tear-out did not create a WebView');
  const frontend = await collectFrontend(detached, path.join(directory, 'tearout-ready.png'));
  const detachedWindow = await hwnd(detached);
  await eventually(async () => (await snapshot(page)).tabCount === 1, 'Source tab was not removed after acceptance');
  const moved = await snapshot(detached);
  for (const key of ['text', 'path', 'dirty', 'selection']) assert.equal(moved[key], before[key], `Tear-out changed ${key}`);
  assert.equal(moved.tabCount, 1);
  const backFrom = await point(detached, detached.locator('.tab.active'));
  const backTo = await point(page, page.locator('.tabbar'));
  await native(['-Action', 'Raise', '-WindowHandle', String(sourceWindow.handle)]);
  await drag(detached, backFrom, backTo);
  await eventually(async () => (await snapshot(page)).tabCount === 2, 'Physical merge did not return the tab');
  const merged = await snapshot(page);
  for (const key of ['text', 'path', 'dirty', 'selection']) assert.equal(merged[key], before[key], `Merge changed ${key}`);
  await eventually(() => detached.isClosed(), 'Empty detached source did not close after the successful merge');
  assert.equal(await readFile(fixture, 'utf8'), content, 'The original fixture was modified');
  await page.screenshot({ path: path.join(directory, 'tearout-merged.png') });
  return { openedAt, handle: String(detachedWindow.handle), frontend, before, moved, merged, roundTripPass: true };
}
async function cleanup(directory) {
  for (const page of browser?.contexts()[0]?.pages() || []) {
    if (!page.isClosed()) await invoke(page, 'plugin:window|close', { label: await page.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label).catch(() => undefined) }).catch(() => {});
  }
  if (ownedChild && ownedChild.exitCode === null) {
    await sleep(500);
    if (ownedChild.exitCode === null) await ps(['-Action', 'Close', '-OutputDirectory', directory, '-QaProcessId', String(ownedChild.pid)]).catch(() => {});
    await eventually(() => ownedChild.exitCode !== null, `Owned QA process ${ownedChild.pid} did not close; it was not killed`, 5000);
  }
  await browser?.close().catch(() => {});
  browser = undefined;
  await writeFile(path.join(directory, 'stop-observer.txt'), 'stop');
  if (observer) await eventually(() => observer.exitCode !== null, 'Native observer did not stop', 5000);
  observer = ownedChild = undefined;
}

await access(executable);
const executableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
await mkdir(output, { recursive: true });
console.log(`Native startup evidence: ${output}`);
for (const scenario of scenarios) {
  assert.ok(['normal', 'remembered', 'maximized', 'memory-off'].includes(scenario), `Unknown scenario ${scenario}`);
  await refuseExisting();
  const directory = path.join(output, scenario);
  await mkdir(path.join(directory, 'appdata/Boshu'), { recursive: true });
  await writeFile(path.join(directory, 'appdata/Boshu/settings.json'), JSON.stringify({
    'workbench.language': 'zh-CN', 'updates.lastCheckedAt': Date.now(), 'updates.intervalHours': 720,
    'window.rememberSize': scenario !== 'memory-off',
    'window.closeLastTabExits': testTearOut,
  }));
  if (scenario !== 'normal') await writeFile(path.join(directory, 'appdata/Boshu/window-state.json'), JSON.stringify({ version: 1, width: 916, height: 612, maximized: scenario === 'maximized' }));
  const observerErrors = [];
  observer = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-OutputDirectory', directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  observer.stderr.on('data', data => observerErrors.push(data.toString()));
  let page, frontend, secondaryFrontend, secondaryOpenedAt, transfer;
  let launchAt, ownedPid;
  try {
    await eventually(async () => {
      if (observer.exitCode !== null) throw new Error(`Native observer failed: ${observerErrors.join('')}`);
      return exists(path.join(directory, 'observer-ready.txt'));
    }, 'Native observer did not become ready');
    launchAt = Date.now();
    ownedChild = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: {
      ...process.env, APPDATA: path.join(directory, 'appdata'), WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
    } });
    await new Promise((resolve, reject) => { ownedChild.once('spawn', resolve); ownedChild.once('error', reject); });
    ownedPid = ownedChild.pid;
    await writeFile(path.join(directory, 'pid.tmp'), String(ownedChild.pid));
    await rename(path.join(directory, 'pid.tmp'), path.join(directory, 'pid.txt'));
    await eventually(async () => {
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 1000 }); return true; } catch { return false; }
    }, 'CDP did not become available');
    await eventually(() => { page = browser.contexts()[0]?.pages()[0]; return !!page; }, 'WebView target missing');
    frontend = await collectFrontend(page, path.join(directory, 'ready.png'));
    if (openNewWindow && scenario !== 'maximized') {
      const prior = new Set(browser.contexts()[0].pages());
      secondaryOpenedAt = Date.now();
      await invoke(page, 'window_open', { opts: {} });
      let second;
      await eventually(() => { second = browser.contexts()[0].pages().find(target => !prior.has(target)); return !!second; }, 'New native window target missing');
      secondaryFrontend = await collectFrontend(second, path.join(directory, 'new-window-ready.png'));
      if (testTearOut && scenario === 'remembered') {
        await invoke(second, 'plugin:window|close', { label: secondaryFrontend.label });
        await eventually(() => second.isClosed(), 'Empty test window did not close');
      }
    }
    if (testTearOut && scenario === 'remembered') transfer = await physicalTransfer(page, directory, ownedPid);
  } finally {
    await cleanup(directory);
    await writeFile(path.join(directory, 'observer-stderr.log'), observerErrors.join(''));
  }
  assert.equal(observerErrors.join('').trim(), '', 'Native observer failed; inspect observer-stderr.log');
  const samples = (await readFile(path.join(directory, 'native.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const firstIndex = samples.findIndex(sample => sample.windows.some(window => window.visible));
  assert.ok(firstIndex >= 0, 'No native visible window was observed');
  const first = samples[firstIndex];
  const initial = first.windows.find(window => window.visible);
  const before = samples[firstIndex - 1]?.at ?? null;
  const stable = samples.filter(sample => sample.at >= first.at && sample.at <= first.at + 1000).flatMap(sample => sample.windows.filter(window => window.handle === initial.handle && window.visible));
  const rectChanges = stable.filter(window => ['x', 'y', 'width', 'height', 'clientWidth', 'clientHeight', 'maximized'].some(key => window[key] !== initial[key]));
  const uiReadyAt = frontend.marks.find(mark => mark.name === 'startup:ui-ready')?.at;
  const paintAt = frontend.paints.find(paint => paint.name === 'first-contentful-paint')?.at;
  let readiness;
  if (uiReadyAt !== undefined) readiness = uiReadyAt <= (before ?? first.at) ? 'ready-before-visible' : uiReadyAt > first.at + 2 ? 'visible-before-ready' : 'ready-within-native-sampling-interval';
  else if (paintAt !== undefined && paintAt > first.at + 10) readiness = 'visible-before-first-contentful-paint';
  else if (frontend.dom.domReadyAt !== null && frontend.dom.domReadyAt > first.at + 2) readiness = 'visible-before-observed-dom-ready';
  else readiness = 'baseline-ready-time-inexact';
  const report = { scenario, version: frontend.version, ownedPid, launchAt, firstVisibleAt: first.at, previousSampleAt: before, nativeFirstWindow: initial,
    readiness, uiReadyAt: uiReadyAt ?? null, firstContentfulPaintAt: paintAt ?? null, visibleBeforePaintMs: paintAt === undefined ? null : paintAt - first.at,
    visibleRectChanges: rectChanges.length, nativeSampleCount: samples.length,
    maxSampleGapMs: Math.max(...samples.slice(1).map((sample, index) => sample.at - samples[index].at)), frontend,
    pass: ['ready-before-visible', 'ready-within-native-sampling-interval'].includes(readiness) && rectChanges.length === 0,
  };
  if (scenario !== 'maximized') {
    report.expectedClient = scenario === 'remembered' ? { width: 916, height: 612 } : { width: 1000, height: 700 };
    report.clientSizeMatches = frontend.width === report.expectedClient.width && frontend.height === report.expectedClient.height;
    report.nativeClientSizeMatches = initial.clientWidth === Math.round(report.expectedClient.width * initial.dpi / 96) && initial.clientHeight === Math.round(report.expectedClient.height * initial.dpi / 96);
    report.pass &&= report.clientSizeMatches && report.nativeClientSizeMatches;
  } else { report.pass &&= initial.maximized; }
  reports.push(report);
  console.log(`${baseline ? 'BASELINE' : report.pass ? 'PASS' : 'FAIL'} ${scenario}: ${readiness}; first rect ${initial.width}x${initial.height}@${initial.x},${initial.y}; rect changes ${rectChanges.length}; client ${frontend.width}x${frontend.height}`);
  if (secondaryFrontend) {
    const nextIndex = samples.findIndex(sample => sample.at >= secondaryOpenedAt && sample.windows.some(window => window.visible && window.handle !== initial.handle));
    assert.ok(nextIndex >= 0, 'New window was not observed as visible by Win32');
    const next = samples[nextIndex];
    const nextWindow = next.windows.find(window => window.visible && window.handle !== initial.handle);
    const nextReadyAt = secondaryFrontend.marks.find(mark => mark.name === 'startup:ui-ready')?.at;
    const nextStable = samples.filter(sample => sample.at >= next.at && sample.at <= next.at + 1000).flatMap(sample => sample.windows.filter(window => window.handle === nextWindow.handle && window.visible));
    const nextRectChanges = nextStable.filter(window => ['x', 'y', 'width', 'height', 'clientWidth', 'clientHeight', 'maximized'].some(key => window[key] !== nextWindow[key]));
    const nextReadyBeforeVisible = nextReadyAt !== undefined && nextReadyAt <= next.at + 2;
    const nextSizeMatches = secondaryFrontend.width === report.expectedClient.width && secondaryFrontend.height === report.expectedClient.height &&
      nextWindow.clientWidth === Math.round(report.expectedClient.width * nextWindow.dpi / 96) && nextWindow.clientHeight === Math.round(report.expectedClient.height * nextWindow.dpi / 96);
    const secondary = { scenario: `${scenario}:new-window`, version: secondaryFrontend.version, ownedPid, launchAt: secondaryOpenedAt,
      firstVisibleAt: next.at, previousSampleAt: samples[nextIndex - 1]?.at ?? null, nativeFirstWindow: nextWindow,
      uiReadyAt: nextReadyAt ?? null, visibleRectChanges: nextRectChanges.length, frontend: secondaryFrontend,
      pass: nextReadyBeforeVisible && nextSizeMatches && nextRectChanges.length === 0,
    };
    reports.push(secondary);
    console.log(`${baseline ? 'BASELINE' : secondary.pass ? 'PASS' : 'FAIL'} ${secondary.scenario}: ready before visible ${nextReadyBeforeVisible}; rect changes ${nextRectChanges.length}; client ${secondaryFrontend.width}x${secondaryFrontend.height}`);
  }
  if (transfer) {
    const index = samples.findIndex(sample => sample.at >= transfer.openedAt && sample.windows.some(window => window.handle === transfer.handle && window.visible));
    assert.ok(index >= 0, 'Detached HWND was not observed as visible');
    const visible = samples[index];
    const window = visible.windows.find(window => window.handle === transfer.handle);
    const readyAt = transfer.frontend.marks.find(mark => mark.name === 'startup:ui-ready')?.at;
    const stable = samples.filter(sample => sample.at >= visible.at && sample.at <= visible.at + 1000).flatMap(sample => sample.windows.filter(item => item.handle === transfer.handle && item.visible));
    const changes = stable.filter(item => ['x', 'y', 'width', 'height', 'clientWidth', 'clientHeight'].some(key => item[key] !== window[key]));
    const nativeSizeCorrect = window.clientWidth === Math.round(916 * window.dpi / 96) && window.clientHeight === Math.round(612 * window.dpi / 96);
    const result = { scenario: 'remembered:physical-tearout-merge', version: transfer.frontend.version, ownedPid,
      firstVisibleAt: visible.at, previousSampleAt: samples[index - 1]?.at ?? null, uiReadyAt: readyAt ?? null,
      nativeFirstWindow: window, visibleRectChanges: changes.length, ...transfer,
      pass: transfer.roundTripPass && readyAt !== undefined && readyAt <= visible.at + 2 && changes.length === 0 && nativeSizeCorrect && transfer.frontend.width === 916 && transfer.frontend.height === 612,
    };
    reports.push(result);
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.scenario}: round trip ${transfer.roundTripPass}; ready before visible ${readyAt <= visible.at + 2}; rect changes ${changes.length}; client ${transfer.frontend.width}x${transfer.frontend.height}`);
  }
  await writeFile(path.join(output, 'summary.json'), JSON.stringify({ baseline, executable, executableSha256, reports }, null, 2));
}
if (!baseline && reports.some(report => !report.pass)) process.exitCode = 1;
