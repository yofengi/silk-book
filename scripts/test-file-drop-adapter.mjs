import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './test-module.mjs';

async function fixture() {
  let handler;
  let registrations = 0;
  const window = { devicePixelRatio: 1 };
  const current = { onDragDropEvent: async fn => { registrations++; handler = fn; return () => {}; } };
  const mod = await loadModule('src/ipc/tauri.ts', {
    '@tauri-apps/api/core': { Channel: class {}, convertFileSrc() {}, invoke() {} },
    '@tauri-apps/api/window': { Effect: {}, EffectState: {}, Window: class {}, cursorPosition() {}, getAllWindows() {}, getCurrentWindow() {} },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => current },
    '@tauri-apps/api/event': { emitTo() {} },
    '@tauri-apps/plugin-opener': { openUrl() {}, revealItemInDir() {} },
    '@tauri-apps/plugin-dialog': { open() {}, save() {} },
    './types': { validExts: values => values },
  }, { window });
  return { api: mod.tauriIpc, window, current, get registrations() { return registrations; }, emit(payload) { handler({ payload }); } };
}

test('native events subscribe only to the current webview window and preserve event order', async () => {
  const f = await fixture();
  const values = [];
  await f.api.onFileDrop(value => values.push(value));
  assert.equal(f.registrations, 1);
  f.emit({ type: 'enter', paths: ['z.txt', 'a.txt'], position: { x: 150, y: 75 } });
  f.emit({ type: 'over', position: { x: 160, y: 80 } });
  f.emit({ type: 'drop', paths: ['z.txt', 'a.txt'], position: { x: 160, y: 80 } });
  f.emit({ type: 'leave' });
  assert.deepEqual(JSON.parse(JSON.stringify(values)), [
    { type: 'enter', paths: ['z.txt', 'a.txt'], position: { x: 150, y: 75 } },
    { type: 'over', position: { x: 160, y: 80 } },
    { type: 'drop', paths: ['z.txt', 'a.txt'], position: { x: 160, y: 80 } },
    { type: 'leave' },
  ]);
});

test('physical webview coordinates convert to CSS pixels at the event-time DPI', async () => {
  const f = await fixture();
  const values = [];
  await f.api.onFileDrop(value => values.push(value));
  for (const scale of [1.25, 1.5, 2]) {
    f.window.devicePixelRatio = scale;
    f.emit({ type: 'over', position: { x: 100 * scale, y: 40 * scale } });
  }
  for (const value of values) assert.deepEqual(JSON.parse(JSON.stringify(value.position)), { x: 100, y: 40 });
});

test('independent window subscriptions use their own DPI without duplicate delivery', async () => {
  const a = await fixture();
  const b = await fixture();
  const first = [];
  const second = [];
  a.window.devicePixelRatio = 1.5;
  b.window.devicePixelRatio = 2;
  await a.api.onFileDrop(value => first.push(value));
  await b.api.onFileDrop(value => second.push(value));
  a.emit({ type: 'drop', paths: ['one.txt'], position: { x: 150, y: 75 } });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  b.emit({ type: 'drop', paths: ['two.txt'], position: { x: 200, y: 100 } });
  assert.deepEqual(JSON.parse(JSON.stringify(first[0].position)), { x: 100, y: 50 });
  assert.deepEqual(JSON.parse(JSON.stringify(second[0].position)), { x: 100, y: 50 });
});
