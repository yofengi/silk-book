import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule, fakeTimers } from './test-module.mjs';
import { testDom } from './test-dom.mjs';

const item = (id, options = {}) => ({ id, name: id, title: id, active: false, dirty: false, special: false, moving: false, ...options });

async function fixture({ reduced = false, animated = true } = {}) {
  const dom = testDom();
  const timers = fakeTimers();
  const animations = [];
  const media = { matches: reduced, addEventListener(_type, fn) { this.changed = fn; } };
  dom.window.matchMedia = () => media;
  const create = dom.document.createElement;
  dom.document.createElement = (tag) => {
    const node = create(tag);
    node.dataset = {};
    node.insertBefore = (child, before) => {
      child.remove();
      const index = before ? node.children.indexOf(before) : node.children.length;
      node.children.splice(index, 0, child);
      child.parentElement = node;
    };
    Object.defineProperty(node, 'firstElementChild', { get: () => node.children[0] ?? null });
    Object.defineProperty(node, 'nextElementSibling', { get: () => node.parentElement?.children[node.parentElement.children.indexOf(node) + 1] ?? null });
    node.getBoundingClientRect = () => {
      const left = node.parentElement?.children.indexOf(node) * 100 || 0;
      return { left, right: left + 100, top: 0, bottom: 28, width: 100, height: 28 };
    };
    node.cloneNode = (deep) => {
      const copy = dom.document.createElement(tag);
      copy.className = node.className;
      copy.dataset = { ...node.dataset };
      copy.attrs = { ...node.attrs };
      if (deep) copy.append(...node.children.map((child) => child.cloneNode(true)));
      return copy;
    };
    const removeAttr = node.removeAttribute.bind(node);
    node.removeAttribute = (key) => { removeAttr(key); if (key === 'data-tab-id') delete node.dataset.tabId; };
    if (animated) node.animate = (frames, options) => {
      const animation = {
        node, frames, options, cancelled: false,
        cancel() { this.cancelled = true; this.oncancel?.(); },
        finish() { this.onfinish?.(); },
      };
      animations.push(animation);
      return animation;
    };
    return node;
  };
  const bar = dom.document.createElement('nav');
  dom.document.body.append(bar);
  const calls = [];
  const mod = await loadModule('src/ui/tab-renderer.ts', {
    './tab-motion.css': {},
    '../i18n': { t: (key, values) => `${key}:${values?.name ?? ''}` },
  }, { ...dom, ...timers });
  const render = mod.createTabRenderer(bar, (command, id) => { calls.push([command, id]); });
  const tab = (id) => bar.children.find((node) => node.dataset.tabId === id);
  const control = (id, cls) => tab(id)?.children.find((node) => node.classList.contains(cls));
  return { ...dom, bar, render, tab, control, calls, animations, timers, media };
}

test('single file and settings tabs hide close controls, while two total tabs expose both', async () => {
  const f = await fixture();
  f.render([item('file')]);
  assert.equal(f.control('file', 'tab-close').hidden, true);
  assert.equal(f.control('file', 'tab-close').tabIndex, -1);
  f.render([item('file'), item('settings', { special: true })]);
  assert.equal(f.control('file', 'tab-close').hidden, false);
  assert.equal(f.control('settings', 'tab-close').hidden, false);
  f.render([item('settings', { special: true })]);
  assert.equal(f.control('settings', 'tab-close').hidden, true);
});

test('dirty single tab retains a noninteractive dot and middle click still closes it', async () => {
  const f = await fixture();
  f.render([item('file', { dirty: true })]);
  const dot = f.control('file', 'tab-dirty-dot');
  assert.equal(dot.hidden, false);
  assert.equal(dot.tagName, 'span');
  assert.equal(dot.tabIndex, undefined);
  f.tab('file').dispatchEvent({ type: 'auxclick', button: 1 });
  assert.deepEqual(f.calls, [['tab.close', 'file']]);
  f.render([item('file')]);
  assert.equal(dot.hidden, true);
});

test('typing, activation, language and metadata changes keep tab nodes and focused controls without replay', async () => {
  const f = await fixture();
  f.render([item('a'), item('b')]);
  const a = f.tab('a');
  const close = f.control('a', 'tab-close');
  close.focus();
  f.render([item('a', { dirty: true, name: 'changed', title: '/changed', active: true }), item('b')]);
  assert.equal(f.tab('a'), a);
  assert.equal(f.control('a', 'tab-close'), close);
  assert.equal(f.document.activeElement, close);
  assert.equal(f.control('a', 'tab-name').textContent, 'changed');
  assert.equal(f.animations.length, 0);
  f.render([item('a', { moving: true }), item('b')]);
  assert.equal(close.disabled, true);
  assert.equal(a.getAttribute('aria-busy'), 'true');
  f.render([item('a'), item('b')]);
  assert.equal(a.getAttribute('aria-busy'), null);
});

test('insertion animates the new tab and displaced siblings, and removal immediately updates live selectors', async () => {
  const f = await fixture();
  f.render([item('a'), item('c')]);
  f.render([item('a'), item('b'), item('c')]);
  assert.ok(f.animations.some((animation) => animation.node === f.tab('b') && animation.frames[0].opacity === 0));
  assert.ok(f.animations.some((animation) => animation.node === f.tab('c') && animation.frames[0].transform.includes('-100px')));
  f.animations.forEach((animation) => animation.finish());
  const removed = f.tab('b');
  f.render([item('a'), item('c')]);
  assert.equal(removed.isConnected, false);
  assert.deepEqual(f.bar.children.map((node) => node.dataset.tabId), ['a', 'c']);
  const ghost = f.document.body.children.find((node) => node !== f.bar);
  assert.ok(ghost);
  assert.equal(ghost.dataset.tabId, undefined);
  assert.equal(ghost.getAttribute('role'), null);
  assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.equal(ghost.inert, true);
  assert.equal(ghost.listeners.size, 0);
  assert.ok(f.animations.some((animation) => animation.node === f.tab('c') && animation.frames[0].transform.includes('100px')));
  await f.timers.run();
  assert.deepEqual(f.document.body.children, [f.bar]);
});

test('rapid open/close, pointer dragging and reduced-motion changes cancel animations and discard ghosts', async () => {
  const f = await fixture();
  f.render([item('a'), item('b')]);
  f.render([item('a')]);
  f.render([item('a'), item('b')]);
  assert.deepEqual(f.document.body.children, [f.bar]);
  f.bar.dispatchEvent({ type: 'pointerdown' });
  assert.ok(f.animations.every((animation) => animation.cancelled));
  const count = f.animations.length;
  f.document.body.classList.add('tab-dragging');
  f.render([item('b'), item('a')]);
  f.render([item('a')]);
  assert.equal(f.animations.length, count);
  f.document.body.classList.remove('tab-dragging');
  f.render([item('a'), item('c')]);
  f.media.matches = true;
  f.media.changed();
  assert.ok(f.animations.every((animation) => animation.cancelled));
  f.render([item('c')]);
  assert.deepEqual(f.document.body.children, [f.bar]);
  await f.timers.run();
  assert.deepEqual(f.document.body.children, [f.bar]);
});

test('initial render, reorder, reduced motion and unsupported animation APIs commit immediately', async () => {
  for (const options of [{ reduced: true }, { animated: false }, {}]) {
    const f = await fixture(options);
    f.render([item('a'), item('b')]);
    f.render([item('b'), item('a')]);
    assert.equal(f.animations.length, 0);
    assert.deepEqual(f.bar.children.map((node) => node.dataset.tabId), ['b', 'a']);
    if (options.reduced || options.animated === false) {
      f.render([item('b')]);
      assert.equal(f.animations.length, 0);
      assert.deepEqual(f.document.body.children, [f.bar]);
    }
  }
});

test('metadata updates leave running entry motion intact and reordering cancels it without replay', async () => {
  const f = await fixture();
  f.render([item('a')]);
  f.render([item('a'), item('b')]);
  const entry = f.animations.find((animation) => animation.node === f.tab('b'));
  assert.ok(entry);
  const count = f.animations.length;
  f.render([item('a'), item('b', { dirty: true })]);
  assert.equal(entry.cancelled, false);
  assert.equal(f.animations.length, count);
  f.render([item('b', { dirty: true }), item('a')]);
  assert.equal(entry.cancelled, true);
  assert.equal(f.animations.length, count);
});

test('batch removal leaves one live tab, returns hidden-close focus and clears every exit ghost', async () => {
  const f = await fixture();
  f.render([item('a'), item('b'), item('c'), item('d')]);
  f.control('c', 'tab-close').focus();
  f.render([item('c', { dirty: true, active: true })]);
  assert.deepEqual(f.bar.children.map((node) => node.dataset.tabId), ['c']);
  assert.equal(f.document.activeElement, f.tab('c'));
  assert.equal(f.control('c', 'tab-dirty-dot').hidden, false);
  assert.equal(f.document.body.children.length, 4);
  f.animations.forEach((animation) => animation.finish());
  assert.deepEqual(f.document.body.children, [f.bar]);
  await f.timers.run();
  assert.deepEqual(f.document.body.children, [f.bar]);
});

test('close controls keep command semantics and focus returns to a remaining active tab', async () => {
  const f = await fixture();
  f.render([item('a'), item('b')]);
  const close = f.control('a', 'tab-close');
  close.click();
  assert.deepEqual(f.calls, [['tab.close', 'a']]);
  close.focus();
  f.render([item('b', { active: true })]);
  assert.equal(f.document.activeElement, f.tab('b'));
  f.tab('b').dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.deepEqual(f.calls.at(-1), ['tab.activate', 'b']);
});
