import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './test-module.mjs';
import { testDom } from './test-dom.mjs';

async function fixture() {
  let now = 10_000;
  let seq = 0;
  const jobs = new Map();
  const values = new Map([['updates.intervalHours', 24], ['updates.lastCheckedAt', 0], ['updates.ignoredVersion', '']]);
  const calls = [];
  let blocked = false;
  let cachedResult = null;
  const listeners = new Map();
  const events = {
    on(type, fn) { const handlers = listeners.get(type) ?? new Set(); handlers.add(fn); listeners.set(type, handlers); return () => handlers.delete(fn); },
    emit(type, payload) { for (const fn of listeners.get(type) ?? []) fn(payload); },
  };
  let checkedListener;
  let response = { status: 'available', checkedAt: now, release: { version: '0.2.0', notes: 'Changes', url: 'https://github.com/yofengi/silk-book/releases/tag/v0.2.0', asset: { name: 'silk-book-0.2.0-windows-x64-setup.exe', url: 'https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book-0.2.0-windows-x64-setup.exe' } } };
  const ipc = {
    updateInfo: async () => ({ currentVersion: '0.1.0', platform: 'Windows x64', repositoryUrl: 'https://github.com/yofengi/silk-book', cachedResult }),
    onUpdatesChecked: async (fn) => { checkedListener = fn; },
    checkUpdates: async (manual) => {
      calls.push(manual);
      values.set('updates.lastCheckedAt', now);
      if (response instanceof Error) throw { kind: 'updateNetwork', message: response.message };
      return response;
    },
    openUpdateLink: async (target, version) => { calls.push([target, version]); },
  };
  const mod = await loadModule('src/core/updates.ts', {
    '../ipc': { ipc, isIpcError: (e) => !!e?.kind },
    './settings': { getSetting: (key) => values.get(key), setSetting: (key, value) => { values.set(key, value); events.emit('settings.changed', { key }); }, flushSettings: async () => {} },
    './commands': { isCommandExecutionBlocked: () => blocked, registerCommand() {} },
    './events': { events },
    '../i18n': { t: (key) => key },
  }, {
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { jobs.set(++seq, { fn, delay }); return seq; },
    clearTimeout(id) { jobs.delete(id); },
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    mod, calls, values, jobs, settle,
    setNow(value) { now = value; },
    setResponse(value) { response = value; },
    setCachedResult(value) { cachedResult = value; },
    freeze(value) { blocked = value; events.emit('commands.executionChanged', { blocked }); },
    broadcast(value) { checkedListener(value); },
    async fire() { const [id, job] = jobs.entries().next().value; jobs.delete(id); now += job.delay; job.fn(); await settle(); },
  };
}

test('update intervals use the documented hours and recover from invalid/future timestamps', async () => {
  const policy = await loadModule('src/core/update-policy.ts');
  const hour = 3_600_000;
  for (const hours of [1, 24, 168, 720]) assert.equal(policy.updateIntervalHours(hours), hours);
  for (const invalid of [0, -1, 2, NaN, '24']) assert.equal(policy.updateIntervalHours(invalid), 24);
  assert.equal(policy.nextUpdateDelay(0, 24, hour), 0);
  assert.equal(policy.nextUpdateDelay(hour, 24, 2 * hour), 23 * hour);
  assert.equal(policy.nextUpdateDelay(hour, 24, 25 * hour), 0);
  assert.equal(policy.nextUpdateDelay(100 * hour, 24, hour), 0);
  assert.equal(policy.nextUpdateDelay(NaN, 24, hour), 0);
});

test('ignored versions only hide matching background notifications, including releases without assets', async () => {
  const { shouldNotifyUpdate } = await loadModule('src/core/update-policy.ts');
  const update = { status: 'available', release: { version: '0.2.0' } };
  assert.equal(shouldNotifyUpdate(update, ''), true);
  assert.equal(shouldNotifyUpdate(update, '0.2.0'), false);
  assert.equal(shouldNotifyUpdate(update, '0.1.0'), true);
  assert.equal(shouldNotifyUpdate({ ...update, status: 'noAsset' }, ''), true);
  assert.equal(shouldNotifyUpdate({ status: 'current' }, ''), false);
  assert.equal(shouldNotifyUpdate({ status: 'noReleases' }, ''), false);
});

test('startup waits before checking and monthly scheduling uses bounded timers', async () => {
  const f = await fixture();
  f.values.set('updates.intervalHours', 720);
  f.mod.startUpdateService();
  await f.settle();
  assert.deepEqual(f.calls, []);
  assert.equal([...f.jobs.values()][0].delay, 12_000);
  await f.fire();
  assert.deepEqual(f.calls, [false]);
  assert.equal(f.mod.getUpdateState().result.status, 'available');
  const delay = [...f.jobs.values()][0].delay;
  assert.equal(delay, 24 * 3_600_000);
  f.mod.stopUpdateService();
  assert.equal(f.jobs.size, 0);
});

test('background errors stay quiet while manual checks show errors and retry', async () => {
  const f = await fixture();
  f.mod.startUpdateService();
  f.setResponse(new Error('offline'));
  await f.fire();
  assert.equal(f.mod.getUpdateState().errorKind, null);
  await f.mod.checkForUpdates(true);
  assert.equal(f.mod.getUpdateState().errorKind, 'updateNetwork');
  f.setResponse({ status: 'noReleases', checkedAt: 22_000, release: null });
  await f.mod.checkForUpdates(true);
  assert.equal(f.mod.getUpdateState().result.status, 'noReleases');
  assert.equal(f.mod.getUpdateState().errorKind, null);
  f.mod.stopUpdateService();
});

test('manual checks preserve ignored releases and same-window requests share one promise', async () => {
  const f = await fixture();
  f.values.set('updates.ignoredVersion', '0.2.0');
  f.mod.startUpdateService();
  const first = f.mod.checkForUpdates(true);
  const second = f.mod.checkForUpdates(true);
  assert.equal(first, second);
  await first;
  assert.equal(f.calls.length, 1);
  assert.equal(f.mod.getUpdateState().result.release.version, '0.2.0');
  assert.equal(f.mod.getUpdateNotification(), null);
  f.values.set('updates.ignoredVersion', '0.1.0');
  assert.equal(f.mod.getUpdateNotification().release.version, '0.2.0');
  f.mod.stopUpdateService();
});

test('new windows show the process cache immediately without starting another network request', async () => {
  const f = await fixture();
  f.values.set('updates.lastCheckedAt', 8_000);
  f.setCachedResult({ status: 'noAsset', checkedAt: 8_000, release: { version: '0.2.0', notes: 'Changes', asset: null } });
  f.mod.startUpdateService();
  await f.settle();
  assert.equal(f.mod.getUpdateNotification().status, 'noAsset');
  assert.deepEqual(f.calls, []);
  f.mod.stopUpdateService();
});

test('clock rollback accepts a successful new revision and rejects later stale broadcasts', async () => {
  const f = await fixture();
  f.mod.startUpdateService();
  f.setNow(100_000);
  f.setResponse({ status: 'available', checkedAt: 100_000, revision: 1, release: { version: '0.2.0', asset: null } });
  await f.mod.checkForUpdates(true);
  f.setNow(50_000);
  f.setResponse({ status: 'noAsset', checkedAt: 50_000, revision: 2, release: { version: '0.3.0', asset: null } });
  await f.mod.checkForUpdates(true);
  assert.equal(f.mod.getUpdateState().result.release.version, '0.3.0');
  f.broadcast({ status: 'available', checkedAt: 200_000, revision: 1, release: { version: '0.2.0', asset: null } });
  assert.equal(f.mod.getUpdateState().result.release.version, '0.3.0');
  f.mod.stopUpdateService();
});

test('command freeze blocks checks and update writes and resumes background scheduling', async () => {
  const f = await fixture();
  f.mod.startUpdateService();
  f.freeze(true);
  assert.equal(f.jobs.size, 0);
  await f.mod.checkForUpdates(true);
  f.mod.setUpdateInterval(1);
  await f.mod.ignoreUpdate();
  await f.mod.openUpdateLink('repository');
  assert.deepEqual(f.calls, []);
  assert.equal(f.values.get('updates.intervalHours'), 24);
  assert.equal(f.values.get('updates.ignoredVersion'), '');
  f.freeze(false);
  assert.equal(f.jobs.size, 1);
  await f.fire();
  assert.deepEqual(f.calls, [false]);
  f.mod.stopUpdateService();
});

test('topbar notification safely displays notes and closes while commands are frozen', async () => {
  const dom = testDom();
  const originalCreate = dom.document.createElement;
  dom.document.createElement = (tag) => Object.assign(originalCreate(tag), { dataset: {} });
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  let blocked = false;
  const release = { version: '0.2.0', notes: '<script>untrusted()</script>\n## Changes', asset: { name: 'installer.exe' } };
  const state = { result: { status: 'available', release }, info: { platform: 'Windows x64' }, errorKind: null };
  const mod = await loadModule('src/ui/updates.ts', {
    './updates.css': {},
    '../core/commands': {
      registerCommand: (command) => commands.set(command.id, command),
      isCommandExecutionBlocked: () => blocked,
      async executeCommand(id) { if (!blocked) { calls.push(id); return commands.get(id)?.run(); } },
    },
    '../core/events': { events: { on(type, fn) { handlers.set(type, fn); return () => {}; } } },
    '../core/updates': { getUpdateNotification: () => state.result, getUpdateState: () => state },
    '../i18n': { t: (key) => key },
    './update-text': { updateErrorText: () => 'error', updateResultText: () => 'available' },
  }, dom);
  const button = mod.createUpdateButton();
  dom.document.body.append(button);
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const panel = dom.document.body.children.find((child) => child.getAttribute('role') === 'dialog');
  assert.ok(panel);
  const notes = panel.children.find((child) => child.tagName === 'pre');
  assert.equal(notes.textContent, release.notes);
  assert.equal(notes.innerHTML, undefined);
  blocked = true;
  handlers.get('commands.executionChanged')({ blocked: true });
  assert.equal(panel.isConnected, false);
  assert.equal(button.disabled, true);
  const before = calls.length;
  button.click();
  assert.equal(calls.length, before);
});
