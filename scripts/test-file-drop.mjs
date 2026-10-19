import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './test-module.mjs';
import { testDom } from './test-dom.mjs';

async function fixture({ pending = false } = {}) {
  const dom = testDom();
  const callbacks = new Map();
  const windowCallbacks = new Map();
  const frames = new Map();
  const calls = [];
  let blocked = false;
  let modal = false;
  let listener;
  let frameId = 0;
  let release;
  const subscribed = pending ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const bar = dom.document.createElement('nav');
  bar.clientWidth = 220;
  bar.scrollWidth = 340;
  bar.scrollLeft = 0;
  const order = ['alpha', 'settings', 'omega'];
  bar.getBoundingClientRect = () => ({ left: 10, right: 230, top: 40, bottom: 72, width: 220, height: 32 });
  for (const id of order) {
    const tab = dom.document.createElement('div');
    tab.dataset = { tabId: id };
    tab.getBoundingClientRect = () => {
      const left = 10 + order.indexOf(id) * 110 - bar.scrollLeft;
      return { left, right: left + 100, top: 40, bottom: 72, width: 100, height: 32 };
    };
    bar.append(tab);
  }
  bar.querySelectorAll = () => order.map(id => bar.children.find(tab => tab.dataset.tabId === id));
  dom.document.body.append(bar);
  dom.document.elementFromPoint = () => bar;
  dom.document.querySelector = () => modal ? {} : null;
  dom.window.addEventListener = (name, fn) => { windowCallbacks.set(name, fn); };
  const ipc = { onFileDrop: async fn => { listener = fn; await subscribed; } };
  const mod = await loadModule('src/ui/file-drop.ts', {
    './tab-drag.css': {}, '../ipc': { ipc },
    '../core/commands': { isCommandExecutionBlocked: () => blocked, executeCommand: async (id, args) => { calls.push([id, args]); } },
    '../core/events': { events: { on(name, fn) { callbacks.set(name, fn); return () => {}; } } },
  }, {
    ...dom,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const ready = mod.bindFileDrop(bar);
  return {
    dom, calls, bar, frames, order, ready, release,
    emit(value) { listener(value); },
    get marker() { return dom.document.body.children.find(node => node.className.includes('tab-drop-insertion')); },
    block(value) { blocked = value; callbacks.get('commands.executionChanged')?.({ blocked: value }); },
    modal(value) { modal = value; },
    blur() { windowCallbacks.get('blur')?.(); },
    frame() { const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(); },
  };
}

const point = (x, y = 55) => ({ x, y });

test('listener readiness waits for the current-window IPC subscription', async () => {
  const f = await fixture({ pending: true });
  let ready = false;
  f.ready.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  f.release();
  await f.ready;
  assert.equal(ready, true);
});

test('tab drops capture DOM order and a stable insertion anchor for the entire batch', async () => {
  const f = await fixture();
  f.emit({ type: 'enter', paths: ['b.txt', 'a.txt'], position: point(100) });
  assert.ok(f.marker);
  assert.equal(f.marker.style.left, '120px');
  const paths = ['b.txt', 'a.txt'];
  f.emit({ type: 'drop', paths, position: point(100) });
  paths.push('late.txt');
  assert.equal(f.marker, undefined);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), ['file.open', { paths: ['b.txt', 'a.txt'], here: true, drop: true, placement: { index: 1, beforeId: 'settings' } }]);
});

test('first, last and empty tab slots support prepend and append positions', async () => {
  const f = await fixture();
  f.emit({ type: 'drop', paths: ['first.txt'], position: point(12) });
  assert.equal(f.calls[0][1].placement.index, 0);
  assert.equal(f.calls[0][1].placement.beforeId, 'alpha');
  f.bar.scrollLeft = 120;
  f.emit({ type: 'drop', paths: ['last.txt'], position: point(229) });
  assert.equal(f.calls[1][1].placement.index, 3);
  assert.equal(f.calls[1][1].placement.beforeId, undefined);
  f.order.length = 0;
  f.bar.replaceChildren();
  f.emit({ type: 'drop', paths: ['empty.txt'], position: point(80) });
  assert.equal(f.calls[2][1].placement.index, 0);
});

test('body drops use the default file rule and never inherit a stale tab placement', async () => {
  const f = await fixture();
  f.emit({ type: 'enter', paths: ['body.txt'], position: point(100) });
  assert.ok(f.marker);
  f.emit({ type: 'over', position: point(100, 200) });
  assert.equal(f.marker, undefined);
  f.emit({ type: 'drop', paths: ['body.txt'], position: point(100, 200) });
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), ['file.open', { paths: ['body.txt'], here: true, drop: true }]);
});

test('edge hovering scrolls horizontally and recomputes the marker until leaving', async () => {
  const f = await fixture();
  f.emit({ type: 'enter', paths: ['edge.txt'], position: point(228) });
  assert.ok(f.frames.size);
  f.frame();
  assert.ok(f.bar.scrollLeft > 0);
  f.emit({ type: 'over', position: point(12) });
  f.frame();
  assert.equal(f.bar.scrollLeft, 0);
  f.emit({ type: 'leave' });
  assert.equal(f.marker, undefined);
  assert.equal(f.frames.size, 0);
});

test('freeze, body inert, confirmation and internal pointer drags refuse drops', async () => {
  const f = await fixture();
  f.emit({ type: 'enter', paths: ['blocked.txt'], position: point(100) });
  f.block(true);
  assert.equal(f.marker, undefined);
  f.emit({ type: 'drop', paths: ['blocked.txt'], position: point(100) });
  f.block(false);
  f.dom.document.body.inert = true;
  f.emit({ type: 'drop', paths: ['inert.txt'], position: point(100) });
  f.dom.document.body.inert = false;
  f.modal(true);
  f.emit({ type: 'drop', paths: ['modal.txt'], position: point(100) });
  f.modal(false);
  f.dom.document.body.classList.add('tab-dragging');
  f.emit({ type: 'drop', paths: ['pointer.txt'], position: point(100) });
  assert.equal(f.calls.length, 0);
});

test('blur clears insertion and scrolling; empty drops cannot open a file dialog', async () => {
  const f = await fixture();
  f.emit({ type: 'enter', paths: ['blur.txt'], position: point(228) });
  f.blur();
  assert.equal(f.marker, undefined);
  assert.equal(f.frames.size, 0);
  f.emit({ type: 'drop', paths: [], position: point(100) });
  assert.equal(f.calls.length, 0);
});

test('the final drop coordinates select a fresh anchor after tabs reorder', async () => {
  const f = await fixture();
  f.emit({ type: 'enter', paths: ['moving.txt'], position: point(100) });
  f.order.splice(0, 3, 'omega', 'alpha', 'settings');
  f.emit({ type: 'drop', paths: ['moving.txt'], position: point(100) });
  assert.equal(f.calls[0][1].placement.beforeId, 'alpha');
});

test('invalid coordinates and an obscured tabbar never create an insertion target', async () => {
  const f = await fixture();
  f.emit({ type: 'drop', paths: ['invalid.txt'], position: point(NaN) });
  assert.equal(f.calls.length, 0);
  f.dom.document.elementFromPoint = () => f.dom.document.body;
  f.emit({ type: 'enter', paths: ['covered.txt'], position: point(100) });
  assert.equal(f.marker, undefined);
  f.emit({ type: 'drop', paths: ['covered.txt'], position: point(100) });
  assert.equal(f.calls[0][1].placement, undefined);
});
