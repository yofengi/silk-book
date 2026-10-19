import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule, fakeTimers } from './test-module.mjs';
import { testDom } from './test-dom.mjs';

async function fixture() {
  const dom = testDom(), timers = fakeTimers();
  const listeners = new Map(), observers = new Set(), leaving = new Set();
  for (const [prefix, target] of [['document', dom.document], ['window', dom.window]]) {
    target.addEventListener = (type, callback) => {
      const key = `${prefix}:${type}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(callback);
    };
    target.removeEventListener = (type, callback) => listeners.get(`${prefix}:${type}`)?.delete(callback);
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(owner) { this.owner = owner; }
    disconnect() { this.owner = null; }
  }
  const create = dom.document.createElement;
  dom.document.createElement = tag => {
    const node = create(tag);
    node.hasAttribute = name => node.getAttribute(name) !== null;
    node.closest = selector => {
      for (let current = node; current; current = current.parentElement) {
        if (selector === '[title]' && current.getAttribute('title') !== null) return current;
        if (selector === '.titlebar, .statusbar' && ['titlebar', 'statusbar'].some(cls => current.classList.contains(cls))) return current;
      }
      return null;
    };
    return node;
  };
  const root = dom.document.createElement('header');
  root.className = 'titlebar';
  dom.document.body.append(root);
  const button = title => {
    const node = dom.document.createElement('button');
    node.setAttribute('title', title);
    node.setAttribute('aria-label', 'Existing name');
    root.append(node);
    return node;
  };
  const module = await loadModule('src/ui/tooltips.ts', {
    './tooltips.css': {},
    './motion': {
      motionEnter() {},
      motionRemove(node) {
        leaving.add(node);
        const finish = () => { leaving.delete(node); node.remove(); };
        timers.setTimeout(finish);
        return finish;
      },
    },
  }, { ...dom, ...timers, Element: dom.HTMLElement, MutationObserver });
  const dispose = module.initTooltips();
  const dispatch = (type, target, extra = {}, scope = 'document') => {
    for (const listener of listeners.get(`${scope}:${type}`) ?? []) listener({ type, target, ...extra });
  };
  const bubble = () => dom.document.body.children.find(node => node.className === 'ui-tooltip' && !leaving.has(node));
  const mutations = () => { for (const observer of observers) if (observer.owner) observer.callback([]); };
  return { ...dom, timers, root, button, dispatch, bubble, mutations, dispose, listeners };
}

test('delegated hover delays the bubble, restores title and preserves aria', async () => {
  const f = await fixture(), owner = f.button('Save (Ctrl+S)');
  f.dispatch('pointerover', owner);
  assert.equal(owner.getAttribute('title'), null);
  assert.equal(f.bubble(), undefined);
  await f.timers.run();
  assert.equal(f.bubble().textContent, 'Save (Ctrl+S)');
  assert.equal(owner.getAttribute('aria-label'), 'Existing name');
  assert.equal(owner.getAttribute('aria-describedby'), null);
  f.dispatch('pointerout', owner, { relatedTarget: null });
  assert.equal(owner.getAttribute('title'), 'Save (Ctrl+S)');
  await f.timers.run();
  assert.equal(f.bubble(), undefined);
  f.dispose();
});

test('focus shows tooltips and Escape dismisses until the owner changes', async () => {
  const f = await fixture(), owner = f.button('Find');
  f.dispatch('focusin', owner);
  await f.timers.run();
  assert.equal(f.bubble().textContent, 'Find');
  f.dispatch('keydown', owner, { key: 'Escape' });
  f.dispatch('pointerover', owner);
  await f.timers.run();
  assert.equal(f.bubble(), undefined);
  assert.equal(owner.getAttribute('title'), null);
  f.dispatch('focusout', owner, { relatedTarget: null });
  f.dispatch('pointerout', owner, { relatedTarget: null });
  assert.equal(owner.getAttribute('title'), 'Find');
  f.dispatch('pointerover', owner);
  await f.timers.run();
  assert.equal(f.bubble().textContent, 'Find');
  f.dispose();
});

test('asynchronous titles replace displayed text and the latest title is restored', async () => {
  const f = await fixture(), owner = f.button('Old');
  f.dispatch('pointerover', owner);
  await f.timers.run();
  owner.setAttribute('title', 'New');
  f.mutations();
  assert.equal(f.bubble().textContent, 'New');
  assert.equal(owner.getAttribute('title'), null);
  owner.setAttribute('title', 'Newest');
  f.dispatch('scroll', owner);
  assert.equal(owner.getAttribute('title'), null);
  await f.timers.run();
  assert.equal(f.bubble(), undefined);
  f.dispatch('pointerout', owner, { relatedTarget: null });
  assert.equal(owner.getAttribute('title'), 'Newest');
  f.dispose();
});

test('rapid switching cancels pending and exiting bubbles without residue', async () => {
  const f = await fixture(), first = f.button('First'), second = f.button('Second');
  f.dispatch('pointerover', first);
  f.dispatch('pointerover', second);
  await f.timers.run();
  assert.equal(first.getAttribute('title'), 'First');
  assert.equal(f.bubble().textContent, 'Second');
  f.dispatch('pointerout', second, { relatedTarget: null });
  f.dispatch('pointerover', first);
  await f.timers.run();
  assert.equal(f.bubble().textContent, 'First');
  assert.equal(f.document.body.children.filter(node => node.className === 'ui-tooltip').length, 1);
  f.dispatch('pointerdown', first);
  await f.timers.run();
  assert.equal(f.bubble(), undefined);
  f.dispose();
});

test('removed owners and teardown restore titles and release delegated listeners', async () => {
  const f = await fixture(), owner = f.button('Path');
  f.dispatch('pointerover', owner);
  await f.timers.run();
  owner.remove();
  await f.timers.run();
  await f.timers.run();
  assert.equal(f.bubble(), undefined);
  assert.equal(owner.getAttribute('title'), 'Path');
  f.dispose();
  assert.equal([...f.listeners.values()].reduce((count, set) => count + set.size, 0), 0);
  f.dispatch('pointerover', f.button('After disposal'));
  await f.timers.run();
  assert.equal(f.bubble(), undefined);
});

test('editor and preview titles remain native', async () => {
  const f = await fixture(), owner = f.button('Editor title');
  owner.remove();
  f.document.body.append(owner);
  f.dispatch('pointerover', owner);
  await f.timers.run();
  assert.equal(owner.getAttribute('title'), 'Editor title');
  assert.equal(f.bubble(), undefined);
  f.dispose();
});

test('touch does not open a bubble and disposing a pending hover restores title', async () => {
  const f = await fixture(), owner = f.button('Touch');
  f.dispatch('pointerover', owner, { pointerType: 'touch' });
  await f.timers.run();
  assert.equal(f.bubble(), undefined);
  assert.equal(owner.getAttribute('title'), 'Touch');
  f.dispatch('pointerover', owner, { pointerType: 'mouse' });
  assert.equal(owner.getAttribute('title'), null);
  f.dispose();
  f.dispose();
  await f.timers.run();
  assert.equal(f.bubble(), undefined);
  assert.equal(owner.getAttribute('title'), 'Touch');
});

test('menu click and Escape suppress native titles until both hover and focus leave', async () => {
  for (const visible of [false, true]) {
    const f = await fixture(), owner = f.button('Menu (Alt+F)');
    f.dispatch('pointerover', owner);
    if (visible) await f.timers.run();
    f.dispatch('pointerdown', owner);
    f.dispatch('focusin', owner);
    f.dispatch('keydown', owner, { key: 'Escape' });
    for (let tick = 0; tick < 4; tick++) await f.timers.run();
    assert.equal(f.bubble(), undefined);
    assert.equal(owner.getAttribute('title'), null);
    owner.setAttribute('title', 'Menu updated');
    f.mutations();
    assert.equal(owner.getAttribute('title'), null);
    assert.equal(f.bubble(), undefined);
    f.dispatch('pointerout', owner, { relatedTarget: null });
    assert.equal(owner.getAttribute('title'), null);
    f.dispatch('focusout', owner, { relatedTarget: null });
    assert.equal(owner.getAttribute('title'), 'Menu updated');
    f.dispose();
  }
});

test('dismissed title suppression ends on owner switches and disposal', async () => {
  const f = await fixture(), first = f.button('First'), second = f.button('Second');
  f.dispatch('pointerover', first);
  f.dispatch('pointerdown', first);
  first.setAttribute('title', 'First updated');
  f.mutations();
  assert.equal(first.getAttribute('title'), null);
  f.dispatch('pointerover', second);
  assert.equal(first.getAttribute('title'), 'First updated');
  await f.timers.run();
  assert.equal(f.bubble().textContent, 'Second');
  f.dispatch('keydown', second, { key: 'Escape' });
  assert.equal(second.getAttribute('title'), null);
  second.setAttribute('title', 'Second updated');
  f.dispose();
  assert.equal(second.getAttribute('title'), 'Second updated');
  await f.timers.run();
  assert.equal(f.bubble(), undefined);
});
