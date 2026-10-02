// Actual pointer and inter-window probe module, with independent window DOMs.
/* global console, setTimeout, clearTimeout, process */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('src/ui/tab-drag.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  const windows = new Map(); const hits = []; let hitTarget = () => 'win-1';
  function createWindow(label, ids, origin) {
    const order = [...ids]; const commands = []; const subscribers = new Map(); let blocked = false;
    class Element {
      children = []; listeners = new Map(); dataset = {}; style = {}; inert = false; scrollLeft = 0;
      classes = new Set(); classList = { add: (...names) => names.forEach((name) => this.classes.add(name)),
        remove: (...names) => names.forEach((name) => this.classes.delete(name)) };
      append(child) { child.parent = this; this.children.push(child); }
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
      setAttribute() {} removeAttribute(name) { if (name === 'data-tab-id') delete this.dataset.tabId; }
      addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
      emit(name, event = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
      contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
      closest(selector) { return selector === '[data-tab-id]' && this.dataset.tabId ? this : undefined; }
      focus() {} cloneNode() { const copy = new Element(); copy.dataset = { ...this.dataset }; return copy; }
      getBoundingClientRect() {
        const left = this.dataset.tabId ? 10 + order.indexOf(this.dataset.tabId) * 100 : 0;
        const width = this.dataset.tabId ? 80 : 450;
        return { left, right: left + width, top: 40, bottom: 72, width, height: 32 };
      }
      querySelectorAll() { return order.map((id) => this.children.find((node) => node.dataset.tabId === id)).filter(Boolean); }
      setPointerCapture(id) { this.pointer = id; } hasPointerCapture(id) { return this.pointer === id; }
      releasePointerCapture() { this.pointer = undefined; }
    }
    const body = new Element(); const bar = new Element(); body.append(bar);
    for (const id of ids) { const node = new Element(); node.dataset.tabId = id; bar.append(node); }
    const document = new Element(); document.body = body;
    document.createElement = () => new Element(); document.elementFromPoint = () => bar;
    const window = new Element(); window.innerWidth = 450; window.innerHeight = 600;
    const ipc = {
      windowDropTarget: async (point) => { hits.push({ ...point }); return hitTarget(point); },
      bus: {
        label, innerOrigin: async () => origin,
        on: async (name, fn) => { subscribers.set(name, fn); },
        send: async (target, name, value) => { windows.get(target)?.subscribers.get(name)?.(value); },
      },
    };
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module, exports: module.exports, console, setTimeout, clearTimeout,
      document, window, Element, HTMLElement: Element, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      require: (name) => ({
        './tab-drag.css': {}, '../core/commands': {
          isCommandExecutionBlocked: () => blocked,
          executeCommand: async (id, args) => {
            if (blocked) return undefined;
            commands.push([id, args]);
            if (id === 'tab.reorder') { order.splice(order.indexOf(args.id), 1); order.splice(args.index, 0, args.id); }
            return true;
          },
        },
        '../core/events': { events: { on() {} } },
        '../editor/tabs': { allTabIds: () => [...order], listTabs: () => ids.map((id) => ({ id })) },
        '../editor/transfer': { isTransferring: () => false }, '../ipc': { ipc },
      })[name],
    }, { filename: 'src/ui/tab-drag.ts' });
    module.exports.bindTabDragging(bar);
    const result = { module: module.exports, commands, subscribers, bar, body, order, ipc, document, origin,
      block: (value) => { blocked = value; } };
    windows.set(label, result); return result;
  }
  const source = createWindow('main', ['source', 'second'], { x: -200, y: 100, scale: 1.5 });
  const target = createWindow('win-1', ['left', 'right'], { x: 600, y: 100, scale: 2 });
  const pointer = (targetNode, x, y) => ({ target: targetNode, button: 0, isPrimary: true, pointerId: 1,
    clientX: x, clientY: y, screenX: -999, screenY: -999, preventDefault() {} });
  return { source, target, hits, pointer, setHitTarget: (fn) => { hitTarget = fn; } };
}

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
await check('captured pointer release uses physical origin and DPI, then merges into target middle slot', async () => {
  const f = fixture(); const tab = f.source.bar.children[0]; await tick();
  f.source.bar.emit('pointerdown', f.pointer(tab, 35, 55));
  f.source.bar.emit('pointermove', f.pointer(tab, 640, 118 / 1.5)); await tick();
  f.source.bar.emit('pointerup', f.pointer(tab, 640, 118 / 1.5)); await tick(); await tick();
  assert.ok(f.hits.every((point) => point.x === 760 && point.y === 218));
  const moved = f.source.commands.find(([id]) => id === 'tab.moveToNewWindow')[1];
  assert.equal(moved.target, 'win-1'); assert.equal(moved.placement.index, 1); assert.equal(moved.placement.beforeId, 'right');
  assert.equal('x' in moved, false);
});
await check('foreign top-level window receives release even within source client coordinates', async () => {
  const f = fixture(); const tab = f.source.bar.children[0]; f.target.origin.x = -80; await tick();
  f.source.bar.emit('pointerdown', f.pointer(tab, 35, 55));
  f.source.bar.emit('pointermove', f.pointer(tab, 100, 58)); await tick();
  f.source.bar.emit('pointerup', f.pointer(tab, 100, 58)); await tick(); await tick();
  const move = f.source.commands.find(([id]) => id === 'tab.moveToNewWindow');
  assert.ok(move, 'release must query real top-level window instead of using source client bounds');
  assert.equal(move[1].target, 'win-1'); assert.equal(move[1].placement.index, 0);
});
await check('native hit on own client area remains sorting and never detaches', async () => {
  const f = fixture(); const tab = f.source.bar.children[0]; f.setHitTarget(() => 'main'); await tick();
  f.source.bar.emit('pointerdown', f.pointer(tab, 35, 55));
  f.source.bar.emit('pointermove', f.pointer(tab, 220, 55));
  f.source.bar.emit('pointerup', f.pointer(tab, 220, 55)); await tick(); await tick();
  assert.deepEqual(f.source.order, ['second', 'source']);
  assert.equal(f.source.commands.some(([id]) => id === 'tab.moveToNewWindow'), false);
});
await check('release at the first and last target slots yields prepend and append positions', async () => {
  const f = fixture(); await tick();
  await f.source.module.dropTabAtScreenPoint('source', { x: 610, y: 218 });
  await f.source.module.dropTabAtScreenPoint('source', { x: 1480, y: 218 });
  const moves = f.source.commands.filter(([id]) => id === 'tab.moveToNewWindow').map(([, args]) => args);
  assert.equal(moves[0].placement.index, 0); assert.equal(moves[0].placement.beforeId, 'left');
  assert.equal(moves[1].placement.index, 2); assert.equal(moves[1].placement.beforeId, undefined);
});
await check('empty desktop and target editor area preserve detach-to-new-window behaviour', async () => {
  const f = fixture(); await tick(); f.setHitTarget(() => null);
  assert.equal(await f.source.module.dropTabAtScreenPoint('source', { x: 760, y: 218 }, { x: 100, y: 200 }), true);
  f.setHitTarget(() => 'win-1');
  assert.equal(await f.source.module.dropTabAtScreenPoint('source', { x: 760, y: 500 }, { x: 200, y: 300 }), true);
  const moves = f.source.commands.filter(([id]) => id === 'tab.moveToNewWindow').map(([, args]) => args);
  assert.equal(moves.every((args) => args.target === undefined), true);
  assert.equal(moves[0].x, 100); assert.equal(moves[1].y, 300);
});
await check('blocked target cannot receive a drop or cause a fallback detached window', async () => {
  const f = fixture(); await tick(); f.target.block(true);
  assert.equal(await f.source.module.dropTabAtScreenPoint('source', { x: 760, y: 218 }), false);
  assert.equal(f.source.commands.length, 0);
});
await check('failed target probe preserves source and does not detach to another window', async () => {
  const f = fixture(); await tick(); f.source.ipc.bus.send = async () => { throw Error('closed target'); };
  assert.equal(await f.source.module.dropTabAtScreenPoint('source', { x: 760, y: 218 }), false);
  assert.equal(f.source.commands.length, 0);
});
await check('foreign insertion preview clears when captured drag is cancelled', async () => {
  const f = fixture(); const tab = f.source.bar.children[0]; await tick();
  f.source.bar.emit('pointerdown', f.pointer(tab, 35, 55));
  f.source.bar.emit('pointermove', f.pointer(tab, 640, 118 / 1.5)); await tick();
  assert.ok(f.target.body.children.some((node) => node.className === 'tab-drop-insertion'));
  f.source.bar.emit('pointercancel', f.pointer(tab, 640, 118 / 1.5)); await tick();
  assert.equal(f.target.body.children.some((node) => node.className === 'tab-drop-insertion'), false);
  assert.equal(f.source.commands.some(([id]) => id === 'tab.moveToNewWindow'), false);
  assert.deepEqual(f.source.order, ['source', 'second']);
});
await check('existing same-window sorting and Escape cancellation still restore original order', async () => {
  const f = fixture(); const tab = f.source.bar.children[0]; await tick();
  f.source.bar.emit('pointerdown', f.pointer(tab, 35, 55));
  f.source.bar.emit('pointermove', f.pointer(tab, 220, 55));
  assert.deepEqual(f.source.order, ['second', 'source']);
  f.source.document.emit('keydown', { key: 'Escape', preventDefault() {} });
  assert.deepEqual(f.source.order, ['source', 'second']);
  assert.equal(f.source.commands.some(([id]) => id === 'tab.moveToNewWindow'), false);
});
if (failures.length) process.exitCode = 1;
