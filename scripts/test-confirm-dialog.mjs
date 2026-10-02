/* global AbortController */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './test-module.mjs';
import { testDom } from './test-dom.mjs';

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function fixture() {
  const dom = testDom();
  const create = dom.document.createElement;
  const keyHandlers = new Map();
  const focusJobs = [];
  let opened = 0;
  let locale = 'en';
  let changed;
  dom.document.documentElement = create('html');
  dom.document.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'dialog') {
      node.open = false;
      node.showModal = () => { node.open = true; node.setAttribute('open', ''); opened++; };
      node.close = () => { node.open = false; node.removeAttribute('open'); node.dispatchEvent({ type: 'close' }); };
    }
    return node;
  };
  dom.window.addEventListener = (type, fn) => { const list = keyHandlers.get(type) ?? []; list.push(fn); keyHandlers.set(type, list); };
  const mod = await loadModule('src/ui/confirm-dialog.ts', {
    './confirm-dialog.css': {},
    '../i18n': { productName: () => 'silk book', t: (key) => `${locale}:${key}` },
    '../core/events': { events: { on(type, fn) { assert.equal(type, 'locale.changed'); changed = fn; return () => {}; } } },
  }, { ...dom, setTimeout: (fn) => { focusJobs.push(fn); return focusJobs.length; }, clearTimeout() {} });
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  const modal = () => [...descendants(dom.document.body), ...descendants(dom.document.documentElement)].find((node) => node.classList.contains('confirm-dialog'));
  const control = (className) => descendants(modal()).find((node) => node.classList.contains(className));
  return {
    mod, dom, modal, control, get opened() { return opened; },
    locale(value) { locale = value; changed({ locale: value }); },
    focus() { while (focusJobs.length) focusJobs.shift()(); },
    key(key, changes = {}) {
      const event = { key, target: dom.document.activeElement, defaultPrevented: false, stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...changes };
      for (const fn of keyHandlers.get('keydown') ?? []) { fn(event); if (event.stopped) break; }
      return event;
    },
  };
}

test('confirmation uses a modal with inert-safe controls, safe text and cancellation focused by default', async () => {
  const f = await fixture();
  f.dom.document.body.inert = true;
  const answer = f.mod.confirmDialog('<img src=x onerror=unsafe()>', '<b>title</b>');
  assert.equal(f.modal().open, true);
  assert.equal(f.control('confirm-dialog-message').textContent, '<img src=x onerror=unsafe()>');
  assert.equal(f.control('confirm-dialog-message').innerHTML, undefined);
  assert.equal(f.control('confirm-dialog-title').textContent, '<b>title</b>');
  assert.equal(f.dom.document.activeElement, f.control('confirm-dialog-cancel'));
  assert.equal(f.control('confirm-dialog-accept').type, 'button');
  f.key('Enter');
  assert.equal(await answer, false);
  assert.equal(f.modal(), undefined);
  assert.equal(f.dom.document.body.inert, true);
});

test('requests serialize and closing one cannot settle the next request with the old abort signal', async () => {
  const f = await fixture();
  const firstSignal = new AbortController();
  const first = f.mod.confirmDialog('first', undefined, { signal: firstSignal.signal });
  const second = f.mod.confirmDialog('second');
  assert.equal(f.opened, 1);
  f.control('confirm-dialog-cancel').click();
  assert.equal(await first, false);
  await settle();
  assert.equal(f.opened, 2);
  firstSignal.abort();
  assert.equal(f.control('confirm-dialog-message').textContent, 'second');
  f.control('confirm-dialog-accept').click();
  assert.equal(await second, true);
});

test('abort removes the active modal and queued requests resolve false without ever opening', async () => {
  const f = await fixture();
  const active = new AbortController();
  const queued = new AbortController();
  const first = f.mod.confirmDialog('active', undefined, { signal: active.signal });
  const second = f.mod.confirmDialog('queued', undefined, { signal: queued.signal });
  const third = f.mod.confirmDialog('last');
  queued.abort();
  assert.equal(await second, false);
  assert.equal(f.opened, 1);
  active.abort();
  assert.equal(f.modal(), undefined);
  assert.equal(await first, false);
  await settle();
  assert.equal(f.opened, 2);
  assert.equal(f.control('confirm-dialog-message').textContent, 'last');
  f.control('confirm-dialog-cancel').click();
  assert.equal(await third, false);
});

test('already aborted requests are declined without opening or disturbing the current modal', async () => {
  const f = await fixture();
  const first = f.mod.confirmDialog('active');
  const controller = new AbortController();
  controller.abort();
  assert.equal(await f.mod.confirmDialog('expired', undefined, { signal: controller.signal }), false);
  assert.equal(f.opened, 1);
  assert.equal(f.control('confirm-dialog-message').textContent, 'active');
  f.key('Escape');
  assert.equal(await first, false);
});

test('Tab stays in the modal, dangerous Enter requires focused acceptance and IME Enter never accepts', async () => {
  const f = await fixture();
  const answer = f.mod.confirmDialog('discard changes?');
  f.key('Tab');
  assert.equal(f.dom.document.activeElement, f.control('confirm-dialog-accept'));
  f.key('Tab');
  assert.equal(f.dom.document.activeElement, f.control('confirm-dialog-cancel'));
  f.key('Tab', { shiftKey: true });
  assert.equal(f.dom.document.activeElement, f.control('confirm-dialog-accept'));
  f.key('Enter', { isComposing: true });
  assert.ok(f.modal());
  f.key('Enter', { repeat: true });
  assert.ok(f.modal());
  f.key('Enter');
  assert.equal(await answer, true);
});

test('modal keyboard routing blocks later application shortcuts but preserves selection copy defaults', async () => {
  const f = await fixture();
  const calls = [];
  f.dom.window.addEventListener('keydown', () => calls.push('editor shortcut'));
  const answer = f.mod.confirmDialog('select and copy this text');
  assert.equal(f.key('c', { ctrlKey: true }).defaultPrevented, false);
  f.key('F1');
  assert.deepEqual(calls, []);
  f.key('Escape');
  assert.equal(await answer, false);
  f.key('F1');
  assert.deepEqual(calls, ['editor shortcut']);
});

test('clicking the backdrop does not approve, and native/programmatic close rejects only once', async () => {
  const f = await fixture();
  let count = 0;
  const answer = f.mod.confirmDialog('confirm?').then((value) => { count++; return value; });
  f.modal().dispatchEvent({ type: 'click', target: f.modal(), clientX: 0, clientY: 0, preventDefault() {} });
  assert.equal(count, 0);
  f.modal().close();
  assert.equal(await answer, false);
  assert.equal(count, 1);
});

test('closing restores the originating focus, while locale changes update persistent controls', async () => {
  const f = await fixture();
  const opener = f.dom.document.createElement('button');
  f.dom.document.body.append(opener);
  opener.focus();
  const answer = f.mod.confirmDialog('confirm?');
  const cancel = f.control('confirm-dialog-cancel');
  f.locale('ja');
  assert.equal(f.control('confirm-dialog-cancel'), cancel);
  assert.equal(cancel.textContent, 'ja:common.cancel');
  cancel.click();
  assert.equal(await answer, false);
  f.dom.document.activeElement = f.dom.document.body;
  f.focus();
  assert.equal(f.dom.document.activeElement, opener);
});

test('module import without a browser is safe, while unsupported showModal uses a visible themed fallback', async () => {
  const noBrowser = await loadModule('src/ui/confirm-dialog.ts', {
    './confirm-dialog.css': {}, '../i18n': { t: () => '', productName: () => '' },
    '../core/events': { events: { on() {} } },
  });
  assert.equal(await noBrowser.confirmDialog('no browser'), false);
  const f = await fixture();
  const create = f.dom.document.createElement;
  f.dom.document.createElement = (tag) => { const node = create(tag); if (tag === 'dialog') node.showModal = () => { throw new Error('unsupported'); }; return node; };
  const answer = f.mod.confirmDialog('not supported');
  assert.ok(f.modal());
  assert.equal(f.modal().tagName, 'div');
  assert.equal(f.dom.document.body.inert, undefined);
  f.control('confirm-dialog-cancel').click();
  assert.equal(await answer, false);
  assert.equal(f.dom.document.body.inert, undefined);
  assert.equal(f.modal(), undefined);
});

test('fallback confirmation never takes inert ownership from a concurrent quit lifecycle', async () => {
  const f = await fixture();
  const create = f.dom.document.createElement;
  f.dom.document.createElement = (tag) => { const node = create(tag); if (tag === 'dialog') node.showModal = undefined; return node; };
  f.dom.document.body.inert = false;
  f.dom.document.body.setAttribute('aria-hidden', 'false');
  const controller = new AbortController();
  const answer = f.mod.confirmDialog('ordinary confirmation', undefined, { signal: controller.signal });
  assert.equal(f.dom.document.body.inert, false);
  assert.equal(f.dom.document.body.getAttribute('aria-hidden'), 'false');
  // A concurrent Quit begins while the ordinary confirmation remains open.
  const previousBodyInert = f.dom.document.body.inert;
  f.dom.document.body.inert = true;
  f.dom.document.body.setAttribute('aria-hidden', 'true');
  controller.abort();
  assert.equal(await answer, false);
  assert.equal(f.dom.document.body.inert, true);
  assert.equal(f.dom.document.body.getAttribute('aria-hidden'), 'true');
  // Quit cancellation restores its own snapshot, not dialog-owned state.
  f.dom.document.body.inert = previousBodyInert;
  assert.equal(f.dom.document.body.inert, false);
  assert.equal(f.modal(), undefined);
});
