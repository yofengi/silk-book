import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './test-module.mjs';
import { testDom } from './test-dom.mjs';

const descendants = (node) => [node, ...node.children.flatMap(descendants)];

function motionDom({ animated = true, reduced = false } = {}) {
  const dom = testDom();
  const animations = [];
  const jobs = new Map();
  const mediaListeners = new Set();
  let sequence = 0;
  const media = {
    matches: reduced,
    addEventListener(_type, handler) { mediaListeners.add(handler); },
    removeEventListener(_type, handler) { mediaListeners.delete(handler); },
  };
  const prototype = dom.HTMLElement.prototype;
  Object.defineProperty(prototype, 'isConnected', { get() {
    return this === dom.document.body || this === dom.document.documentElement || !!this.parentElement?.isConnected;
  } });
  const removeAttribute = prototype.removeAttribute;
  prototype.removeAttribute = function (name) {
    removeAttribute.call(this, name);
    if (name === 'id') this.id = '';
  };
  prototype.blur = function () { if (dom.document.activeElement === this) dom.document.activeElement = dom.document.body; };
  prototype.scrollIntoView = () => {};
  const querySelectorAll = prototype.querySelectorAll;
  prototype.querySelectorAll = function (selector) {
    if (selector === '[id], [aria-modal]') return descendants(this).slice(1).filter((node) => node.id || node.getAttribute('aria-modal') !== null);
    return querySelectorAll.call(this, selector);
  };
  if (animated) prototype.animate = function (frames, options) {
    const handlers = new Map();
    const animation = {
      element: this, frames, options, cancelled: false,
      addEventListener(type, handler) { const list = handlers.get(type) ?? new Set(); list.add(handler); handlers.set(type, list); },
      removeEventListener(type, handler) { handlers.get(type)?.delete(handler); },
      emit(type) { for (const handler of [...handlers.get(type) ?? []]) handler({ type }); },
      cancel() { this.cancelled = true; this.emit('cancel'); },
      get listeners() { return [...handlers.values()].reduce((total, list) => total + list.size, 0); },
    };
    animations.push(animation);
    return animation;
  };
  dom.document.documentElement = dom.document.createElement('html');
  dom.document.documentElement.append(dom.document.body);
  dom.window.matchMedia = () => media;
  dom.getComputedStyle = (node) => ({ opacity: node.style.opacity ?? '1', translate: node.style.translate ?? 'none' });
  dom.setTimeout = (fn, delay) => { jobs.set(++sequence, { fn, delay }); return sequence; };
  dom.clearTimeout = (id) => { jobs.delete(id); };
  return {
    dom, animations, jobs, mediaListeners,
    reduce() { media.matches = true; for (const handler of [...mediaListeners]) handler({ matches: true }); },
    runTimers() { const pending = [...jobs.values()]; jobs.clear(); for (const { fn } of pending) fn(); },
  };
}

async function menuFixture() {
  const f = motionDom();
  const hooks = new Map();
  const commands = new Map();
  const mod = await loadModule('src/ui/menu.ts', {
    '../core/commands': { isEnabled: () => true, registerCommand: (command) => commands.set(command.id, command), executeCommand(id) { commands.get(id)?.run(); } },
    '../core/events': { events: { on(type, handler) { hooks.set(type, handler); } } },
    '../core/keybindings': { formatKey: (key) => key, keybindingFor: () => null, registerKeybinding() {} },
    '../core/settings': { getSetting: () => [] },
    '../i18n': { t: (key) => key },
  }, f.dom);
  const button = mod.createMenuButton();
  f.dom.document.body.append(button);
  return { ...f, mod, button };
}

test('menu closes logically and restores focus while only its outgoing surface remains', async () => {
  const f = await menuFixture();
  f.button.focus();
  f.mod.openMenu();
  const menu = f.dom.document.body.children.find((node) => node.getAttribute('role') === 'menu');
  f.mod.closeMenu(true);
  assert.equal(f.mod.isMenuOpen(), false);
  assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.dom.document.activeElement, f.button);
  assert.equal(menu.isConnected, true);
  assert.equal(menu.inert, true);
  assert.equal(menu.getAttribute('aria-hidden'), 'true');
  assert.equal(menu.style.pointerEvents, 'none');
  f.mod.openMenu();
  const reopened = f.dom.document.body.children.find((node) => node !== menu && node.getAttribute('role') === 'menu');
  f.animations.find((animation) => animation.element === menu && animation.options.duration === 120).emit('finish');
  assert.equal(menu.isConnected, false);
  assert.equal(reopened.isConnected, true);
  assert.equal(f.mod.isMenuOpen(), true);
  f.mod.closeMenu(true);
  f.runTimers();
});

test('progress entry runs once while updates keep the mounted controls', async () => {
  const f = motionDom();
  const { showProgress } = await loadModule('src/ui/progress.ts', { '../i18n': { t: (key) => key } }, f.dom);
  const progress = showProgress(f.dom.document.body, 'Loading');
  const node = f.dom.document.body.children[0];
  progress.update(1, 10);
  progress.update(5, 10);
  progress.setLabel('Still loading');
  assert.equal(f.animations.length, 1);
  assert.equal(f.animations[0].element, node);
  assert.equal(node.children[0].textContent, 'Still loading');
  assert.equal(node.children[2].textContent, '50%');
  progress.close();
  assert.equal(node.inert, true);
  assert.equal(node.isConnected, true);
  f.runTimers();
  assert.equal(node.isConnected, false);
});

test('status menu restores focus while an inert old menu exits above the bar', async () => {
  const f = motionDom();
  const mod = await loadModule('src/ui/statusbar.ts', {
    '../core/commands': { executeCommand() {}, isEnabled: () => true },
    '../core/events': { events: { on() {} } },
    '../core/settings': { getSetting: () => true },
    '../editor/encodings': { encodingLabel: () => 'UTF-8', encodingName: (name) => name, sameEncoding: (a, b) => a === b, loadEncodings: async () => [] },
    '../editor/languages': { languageName: () => 'Plain text' },
    '../editor/tabs': { activeTab: () => ({ doc: { path: 'D:/sample.txt', encoding: 'UTF-8', hasBom: false, eol: 'LF', tier: 'Normal' }, languageId: 'plaintext' }) },
    '../i18n': { t: (key) => key },
  }, f.dom);
  const bar = mod.mountStatusBar();
  f.dom.document.body.append(bar);
  const owner = bar.children.find((node) => node.classList.contains('sb-eol'));
  owner.click();
  const menu = f.dom.document.body.children.find((node) => node.getAttribute('role') === 'menu');
  assert.equal(f.animations[0].frames[0].translate, '0 4px');
  menu.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(owner.getAttribute('aria-expanded'), 'false');
  assert.equal(f.dom.document.activeElement, owner);
  assert.equal(menu.inert, true);
  owner.click();
  const current = f.dom.document.body.children.find((node) => node !== menu && node.getAttribute('role') === 'menu');
  f.animations.find((animation) => animation.element === menu && animation.options.duration === 120).emit('finish');
  assert.equal(current.isConnected, true);
  current.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
  f.runTimers();
});

test('update progress patches the open panel without replaying entry and freeze closes it synchronously', async () => {
  const f = motionDom();
  const create = f.dom.document.createElement;
  f.dom.document.createElement = (tag) => Object.assign(create(tag), { dataset: {} });
  const hooks = new Map();
  const commands = new Map();
  let blocked = false;
  const state = { result: { status: 'available', release: { version: '0.2.0', notes: 'Notes' } }, info: { platform: 'Windows' }, transfer: null };
  const mod = await loadModule('src/ui/updates.ts', {
    './updates.css': {},
    '../core/commands': { isCommandExecutionBlocked: () => blocked, registerCommand: (command) => commands.set(command.id, command), executeCommand(id) { commands.get(id)?.run(); } },
    '../core/events': { events: { on(type, handler) { hooks.set(type, handler); } } },
    '../core/updates': { getUpdateNotification: () => state.result, getUpdateState: () => state },
    '../i18n': { t: (key) => key },
    './update-text': { updateErrorText: () => 'error', updateResultText: () => 'available', updateTransferText: () => 'transfer', updateTransferPercent: () => null, updateProgressText: () => 'progress' },
  }, f.dom);
  const button = mod.createUpdateButton();
  f.dom.document.body.append(button);
  button.click();
  const old = f.dom.document.body.children.find((node) => node.classList.contains('update-panel'));
  state.transfer = { phase: 'downloading', taskId: 'download' };
  hooks.get('updates.changed')();
  hooks.get('updates.changed')();
  assert.equal(f.animations.length, 1);
  assert.equal(f.animations[0].element, old);
  blocked = true;
  hooks.get('commands.executionChanged')({ blocked });
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(old.inert, true);
  assert.equal(descendants(old).some((node) => node.id), false);
  blocked = false;
  hooks.get('commands.executionChanged')({ blocked });
  button.click();
  const current = f.dom.document.body.children.find((node) => node !== old && node.classList.contains('update-panel'));
  f.animations.find((animation) => animation.element === old && animation.options.duration === 120).emit('finish');
  assert.equal(current.isConnected, true);
  button.click();
  f.runTimers();
});

test('picker releases its overlay immediately on command freeze and old exits cannot remove a new picker', async () => {
  const f = motionDom();
  const hooks = new Map();
  let blocked = false;
  const { openPicker } = await loadModule('src/ui/palette.ts', {
    '../core/commands': { isCommandExecutionBlocked: () => blocked, commandTitle() {}, executeCommand() {}, isEnabled() {}, listCommands() {} },
    '../core/events': { events: { on(type, handler) { hooks.set(type, handler); } } },
    '../core/keybindings': { keybindingFor() {} }, '../core/settings': { getSetting() {} }, '../i18n': { t: (key) => key },
  }, f.dom);
  openPicker([{ label: 'Alpha', value: 'a' }], () => {});
  const old = f.dom.document.body.children[0];
  const input = old.children[0].children[0];
  input.value = 'a';
  input.dispatchEvent({ type: 'input' });
  assert.equal(f.animations.length, 2);
  blocked = true;
  hooks.get('commands.executionChanged')({ blocked });
  assert.equal(old.inert, true);
  assert.equal(old.style.pointerEvents, 'none');
  assert.equal(input.getAttribute('aria-controls'), 'palette-list');
  assert.equal(descendants(old).some((node) => node.id), false);
  blocked = false;
  openPicker([{ label: 'Beta', value: 'b' }], () => {});
  const current = f.dom.document.body.children.find((node) => node !== old);
  f.animations.find((animation) => animation.element === old && animation.options.duration === 120).emit('finish');
  assert.equal(old.isConnected, false);
  assert.equal(current.isConnected, true);
  hooks.get('commands.executionChanged')({ blocked: true });
  f.runTimers();
});

async function confirmFixture(native = true) {
  const f = motionDom();
  const create = f.dom.document.createElement;
  const guards = new Map();
  f.dom.window.addEventListener = (type, handler) => { const list = guards.get(type) ?? []; list.push(handler); guards.set(type, list); };
  f.dom.document.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'dialog' && native) {
      node.open = false;
      node.showModal = () => { node.open = true; node.setAttribute('open', ''); };
      node.close = () => { node.open = false; node.removeAttribute('open'); node.dispatchEvent({ type: 'close' }); };
    }
    return node;
  };
  const mod = await loadModule('src/ui/confirm-dialog.ts', {
    './confirm-dialog.css': {}, '../core/events': { events: { on() {} } },
    '../i18n': { productName: () => 'Test', t: (key) => key },
  }, f.dom);
  const modal = () => descendants(f.dom.document.documentElement).find((node) => node.getAttribute('aria-modal') === 'true');
  return { ...f, mod, guards, modal };
}

test('native confirmation releases modal ownership and input guards before its visual exit', async () => {
  const f = await confirmFixture();
  const opener = f.dom.document.createElement('button');
  f.dom.document.body.append(opener);
  opener.focus();
  const first = f.mod.confirmDialog('First');
  const old = f.modal();
  const cancel = descendants(old).find((node) => node.className === 'confirm-dialog-cancel');
  cancel.click();
  assert.equal(await first, false);
  assert.equal(old.open, false);
  assert.equal(old.inert, true);
  assert.equal(old.getAttribute('aria-modal'), null);
  assert.equal(old.isConnected, true);
  assert.equal(f.dom.document.activeElement, opener);
  assert.equal(f.modal(), undefined);
  let prevented = false;
  for (const guard of f.guards.get('pointerdown')) guard({ target: opener, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  assert.equal(prevented, false);
  const second = f.mod.confirmDialog('Second');
  const current = f.modal();
  f.animations.find((animation) => animation.element === old && animation.options.duration === 120).emit('finish');
  assert.equal(current.open, true);
  assert.equal(current.isConnected, true);
  descendants(current).find((node) => node.className === 'confirm-dialog-cancel').click();
  assert.equal(await second, false);
  f.runTimers();
});

test('closing a native confirmation during entry preserves its visible position', async () => {
  const f = await confirmFixture();
  const answer = f.mod.confirmDialog('Close during entry');
  const dialog = f.modal();
  dialog.style.opacity = '0.65';
  dialog.style.translate = '0px -2.75px';
  dialog.getBoundingClientRect = () => ({ left: 170, right: 630, top: 197.25, bottom: 377.25 });
  const before = dialog.getBoundingClientRect();
  descendants(dialog).find((node) => node.className === 'confirm-dialog-cancel').click();
  assert.equal(dialog.open, false);
  const exit = f.animations.find((animation) => animation.element === dialog && animation.options.duration === 120);
  const [x, y] = exit.frames[0].translate.split(/\s+/).map(Number.parseFloat);
  assert.equal(Number.parseFloat(dialog.style.left) + x, before.left);
  assert.equal(Number.parseFloat(dialog.style.top) + y, before.top);
  assert.equal(exit.frames[0].opacity, '0.65');
  assert.equal(await answer, false);
  f.runTimers();
});

test('fallback confirmation exit cannot keep a click blocker or overwrite quit inert ownership', async () => {
  const f = await confirmFixture(false);
  f.dom.document.body.inert = true;
  const answer = f.mod.confirmDialog('Fallback');
  const old = f.modal();
  const overlay = old.parentElement;
  descendants(old).find((node) => node.className === 'confirm-dialog-cancel').click();
  assert.equal(await answer, false);
  assert.equal(f.dom.document.body.inert, true);
  assert.equal(overlay.inert, true);
  assert.equal(overlay.style.pointerEvents, 'none');
  assert.equal(old.getAttribute('aria-modal'), null);
  f.runTimers();
  assert.equal(overlay.isConnected, false);
});

test('motion removes immediately without WAAPI or with reduced motion', async () => {
  for (const options of [{ animated: false }, { reduced: true }]) {
    const f = motionDom(options);
    const { motionEnter, motionRemove } = await loadModule('src/ui/motion.ts', {}, f.dom);
    const node = f.dom.document.createElement('div');
    f.dom.document.body.append(node);
    motionEnter(node);
    motionRemove(node);
    assert.equal(node.isConnected, false);
    assert.equal(f.animations.length, 0);
    assert.equal(f.jobs.size, 0);
  }
});

test('finishing entry releases its animation and media listeners without removing the element', async () => {
  const f = motionDom();
  const { motionEnter } = await loadModule('src/ui/motion.ts', {}, f.dom);
  const node = f.dom.document.createElement('div');
  f.dom.document.body.append(node);
  motionEnter(node, 'panel');
  const animation = f.animations[0];
  assert.equal(animation.options.duration, 160);
  assert.ok(animation.frames[0].opacity < 1);
  assert.equal(animation.frames.at(-1).opacity, 1);
  animation.emit('finish');
  assert.equal(node.isConnected, true);
  assert.equal(animation.listeners, 0);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.jobs.size, 0);
});

test('exit cancels entry, removes IDs and modal semantics, and remains idempotent', async () => {
  const f = motionDom();
  const { motionEnter, motionRemove } = await loadModule('src/ui/motion.ts', {}, f.dom);
  const node = f.dom.document.createElement('section');
  node.id = 'panel';
  node.setAttribute('aria-modal', 'true');
  const child = f.dom.document.createElement('button');
  child.id = 'panel-action';
  node.append(child);
  f.dom.document.body.append(node);
  child.focus();
  motionEnter(node);
  const enter = f.animations[0];
  motionRemove(node);
  motionRemove(node);
  assert.equal(enter.cancelled, true);
  assert.equal(enter.listeners, 0);
  assert.equal(f.animations.length, 2);
  assert.equal(node.id, '');
  assert.equal(child.id, '');
  assert.equal(node.getAttribute('aria-modal'), null);
  assert.equal(f.dom.document.activeElement, f.dom.document.body);
  const exit = f.animations[1];
  exit.cancel();
  assert.equal(node.isConnected, false);
  assert.equal(exit.listeners, 0);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.mediaListeners.size, 0);
});

test('a bounded fallback removes exits when animation events never arrive', async () => {
  const f = motionDom();
  const { motionRemove } = await loadModule('src/ui/motion.ts', {}, f.dom);
  const node = f.dom.document.createElement('div');
  f.dom.document.body.append(node);
  motionRemove(node, 'fade');
  assert.equal(node.isConnected, true);
  assert.equal(f.jobs.size, 1);
  assert.ok([...f.jobs.values()][0].delay <= 300);
  f.runTimers();
  assert.equal(node.isConnected, false);
  assert.equal(f.animations[0].listeners, 0);
  assert.equal(f.mediaListeners.size, 0);
});

test('callers can finish an outgoing surface before its animation completes', async () => {
  const f = motionDom();
  const { motionRemove } = await loadModule('src/ui/motion.ts', {}, f.dom);
  const node = f.dom.document.createElement('div');
  f.dom.document.body.append(node);
  const finish = motionRemove(node);
  assert.equal(typeof finish, 'function');
  finish();
  finish();
  assert.equal(node.isConnected, false);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.animations[0].listeners, 0);
  assert.equal(f.mediaListeners.size, 0);
});

test('enabling reduced motion during entry or exit settles the current effect immediately', async () => {
  for (const phase of ['motionEnter', 'motionRemove']) {
    const f = motionDom();
    const motion = await loadModule('src/ui/motion.ts', {}, f.dom);
    const node = f.dom.document.createElement('div');
    f.dom.document.body.append(node);
    motion[phase](node);
    f.reduce();
    assert.equal(node.isConnected, phase === 'motionEnter');
    assert.equal(f.animations[0].listeners, 0);
    assert.equal(f.mediaListeners.size, 0);
    assert.equal(f.jobs.size, 0);
  }
});
