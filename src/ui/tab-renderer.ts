import { t } from '../i18n';
import { createTabMotion } from './tab-motion';

const ICON_GEAR = `<svg class="tab-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const ICON_CLOSE = `<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false"><path d="M0 0l8 8M8 0L0 8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

export interface TabItem {
  id: string;
  name: string;
  title: string;
  active: boolean;
  dirty?: boolean;
  special?: boolean;
  moving?: boolean;
}

interface TabNode {
  tab: HTMLElement;
  name: HTMLElement;
  close: HTMLButtonElement;
  dot: HTMLElement;
}

export function createTabRenderer(bar: HTMLElement, execute: (command: string, id: string) => unknown) {
  const nodes = new Map<string, TabNode>();
  const motion = createTabMotion(bar);
  let mounted = false;
  let order: string[] = [];

  const create = (item: TabItem): TabNode => {
    const tab = document.createElement('div');
    tab.className = `tab${item.special ? ' special' : ''}`;
    tab.dataset.tabId = item.id;
    tab.setAttribute('role', 'tab');
    tab.tabIndex = 0;
    if (item.special) tab.innerHTML = ICON_GEAR;
    const name = document.createElement('span');
    name.className = 'tab-name';
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.innerHTML = ICON_CLOSE;
    const dot = document.createElement('span');
    dot.className = 'tab-dirty-dot';
    dot.setAttribute('aria-hidden', 'true');
    close.addEventListener('click', (event) => { event.stopPropagation(); void execute('tab.close', item.id); });
    tab.addEventListener('click', () => void execute('tab.activate', item.id));
    tab.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') void execute('tab.activate', item.id); });
    tab.addEventListener('auxclick', (event) => { if (event.button === 1) void execute('tab.close', item.id); });
    tab.append(name, close, dot);
    return { tab, name, close, dot };
  };

  return (items: TabItem[]) => {
    const ids = new Set(items.map((item) => item.id));
    const changed = mounted && (nodes.size !== ids.size || items.some((item) => !nodes.has(item.id)));
    const reordered = mounted && items.some((item, index) => order[index] !== item.id);
    const before = motion.before([...nodes.values()].map(({ tab }) => tab), changed, reordered);
    const focus = document.activeElement instanceof HTMLElement && bar.contains(document.activeElement) ? document.activeElement : undefined;
    const removed: HTMLElement[] = [];
    for (const [id, node] of nodes) {
      if (ids.has(id)) continue;
      node.tab.remove();
      removed.push(node.tab);
      nodes.delete(id);
    }
    const single = items.length === 1;
    items.forEach((item, index) => {
      let node = nodes.get(item.id);
      if (!node) { node = create(item); nodes.set(item.id, node); }
      const { tab, name, close, dot } = node;
      tab.classList.toggle('active', item.active);
      tab.classList.toggle('dirty', !!item.dirty);
      tab.classList.toggle('moving', !!item.moving);
      tab.setAttribute('aria-selected', String(item.active));
      if (item.moving) tab.setAttribute('aria-busy', 'true');
      else tab.removeAttribute('aria-busy');
      tab.title = item.title;
      if (name.textContent !== item.name) name.textContent = item.name;
      close.setAttribute('aria-label', t('tab.closeNamed', { name: item.name }));
      if (single && document.activeElement === close) tab.focus({ preventScroll: true });
      close.hidden = single;
      close.tabIndex = single ? -1 : 0;
      close.disabled = single || !!item.moving;
      dot.hidden = !single || !item.dirty;
      if (bar.children[index] !== tab) bar.insertBefore(tab, bar.children[index] ?? null);
    });
    if (focus && !focus.isConnected) {
      const target = items.find((item) => item.active) ?? items[0];
      if (target) nodes.get(target.id)?.tab.focus({ preventScroll: true });
    } else if (focus?.isConnected && document.activeElement !== focus && !(single && focus.classList.contains('tab-close'))) focus.focus({ preventScroll: true });
    motion.after(before, items.map((item) => nodes.get(item.id)!.tab), removed);
    order = items.map((item) => item.id);
    mounted = true;
  };
}
