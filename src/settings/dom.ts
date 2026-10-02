// 设置页共用的 DOM 小工具（仅在懒加载 chunk 内使用）
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) e.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export function button(label: string, onClick: () => void, cls = 'st-btn'): HTMLButtonElement {
  const b = h('button', { class: cls, text: label });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** 分组：标题 + 可选说明 + 内容 */
export function group(title: string, desc: string | null, ...content: Node[]): HTMLElement {
  const id = `st-g-${Math.random().toString(36).slice(2, 8)}`;
  return h(
    'section',
    { class: 'st-group', attrs: { 'aria-labelledby': id } },
    h('h3', { class: 'st-group-title', text: title, attrs: { id } }),
    desc ? h('p', { class: 'st-desc', text: desc }) : null,
    ...content,
  );
}

/** 行：左侧标签（关联到控件），右侧控件 */
export function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  // 复合控件（下拉栏）用 data-label-target 指明可聚焦的那一个
  const target = control.querySelector<HTMLElement>('[data-label-target]') ?? control;
  const id = target.id || `st-c-${Math.random().toString(36).slice(2, 8)}`;
  target.id = id;
  return h(
    'div',
    { class: 'st-row' },
    h('div', { class: 'st-row-label' }, h('label', { text: label, attrs: { for: id } }), hint ? h('div', { class: 'st-hint', text: hint }) : null),
    h('div', { class: 'st-row-control' }, control),
  );
}

export function numberInput(value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLInputElement {
  const i = h('input', { class: 'st-input st-num', attrs: { type: 'number', min: String(min), max: String(max), step: String(step) } });
  i.value = String(value);
  i.addEventListener('change', () => {
    const v = Number(i.value);
    if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
    else i.value = String(value);
  });
  return i;
}

/** 状态提示（aria-live），用于导入/注册等异步操作结果 */
export function statusLine(): { el: HTMLElement; set(text: string, kind?: 'ok' | 'error' | ''): void } {
  const el = h('div', { class: 'st-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  return {
    el,
    set(text, kind = '') {
      el.textContent = text;
      el.dataset.kind = kind;
    },
  };
}

let ctlSeq = 0;

/** 滑块开关（role=switch）；label 由 row() 通过 for 关联 */
export function toggle(value: boolean, onChange: (v: boolean) => void): HTMLButtonElement {
  const b = h('button', { class: 'st-switch', attrs: { type: 'button', role: 'switch', 'aria-checked': String(value) } });
  b.append(h('span', { class: 'st-switch-thumb' }));
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(v));
    onChange(v);
  });
  return b;
}

export interface SelectOption { value: string; label: string }

/**
 * 毛玻璃下拉栏（按钮 + listbox，与字体组合框同一套浮层样式）。
 * Enter/Space/↓ 打开，↑/↓/Home/End 移动，Enter 选中，Esc / 失焦关闭。
 */
export type Dropdown = HTMLElement & { setOptions(o: SelectOption[]): void; setValue(value: string): void };

export function select(options: SelectOption[], value: string, onChange: (v: string) => void): Dropdown {
  const id = `st-sel-${++ctlSeq}`;
  const btn = h('button', {
    class: 'st-input st-dropdown',
    attrs: { type: 'button', role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': `${id}-list`, 'data-label-target': '' },
  });
  const text = h('span', { class: 'st-dropdown-text' });
  btn.append(text);
  btn.insertAdjacentHTML('beforeend', '<svg class="st-dropdown-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>');
  const list = h('ul', { class: 'st-combo-list st-dropdown-list', attrs: { id: `${id}-list`, role: 'listbox', tabindex: '-1' } });
  list.hidden = true;
  // 点滚动条 / 空白处不让按钮失焦（否则 blur 会关闭列表）
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  let opts = options;
  let cur = value;
  let active = -1;

  const label = () => {
    text.textContent = opts.find((o) => o.value === cur)?.label ?? cur;
    btn.title = text.textContent;
  };
  const render = () => {
    list.replaceChildren(...opts.map((o, i) => {
      const li = h('li', { class: 'st-combo-opt', text: o.label, attrs: { id: `${id}-o${i}`, role: 'option', 'aria-selected': String(o.value === cur) } });
      li.addEventListener('pointerdown', (e) => e.preventDefault());
      li.addEventListener('click', () => pick(i));
      li.addEventListener('pointermove', () => setActive(i));
      return li;
    }));
  };
  const setActive = (i: number) => {
    active = i;
    for (const [j, li] of [...list.children].entries()) li.classList.toggle('active', j === i);
    const li = list.children[i] as HTMLElement | undefined;
    if (li) { btn.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
  };
  const open = () => {
    render();
    list.hidden = false;
    const rect = btn.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const upward = below < Math.min(260, list.scrollHeight) && above > below;
    list.style.top = upward ? 'auto' : 'calc(100% + 4px)';
    list.style.bottom = upward ? 'calc(100% + 4px)' : 'auto';
    list.style.maxHeight = `${Math.max(48, Math.min(260, upward ? above : below))}px`;
    btn.setAttribute('aria-expanded', 'true');
    setActive(Math.max(0, opts.findIndex((o) => o.value === cur)));
  };
  const close = () => {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.removeAttribute('aria-activedescendant');
  };
  const pick = (i: number) => {
    const o = opts[i];
    close();
    if (!o || o.value === cur) return;
    cur = o.value;
    label();
    onChange(cur);
  };
  btn.addEventListener('click', () => (list.hidden ? open() : close()));
  btn.addEventListener('blur', close);
  btn.addEventListener('keydown', (e) => {
    const isOpen = !list.hidden;
    const n = opts.length;
    switch (e.key) {
      case 'ArrowDown': if (!isOpen) open(); else setActive((active + 1) % n); break;
      case 'ArrowUp': if (!isOpen) open(); else setActive((active - 1 + n) % n); break;
      case 'Home': if (isOpen) setActive(0); else return; break;
      case 'End': if (isOpen) setActive(n - 1); else return; break;
      case 'Enter': case ' ': if (isOpen) pick(active); else open(); break;
      case 'Escape': if (isOpen) close(); else return; break;
      case 'Tab': close(); return;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  // listbox 与按钮同在一个相对定位容器中（listbox 不能放进 button）
  const wrap: Dropdown = Object.assign(h('div', { class: 'st-dropdown-wrap' }, btn, list), {
    setOptions(o: SelectOption[]) { opts = o; label(); if (!list.hidden) render(); },
    setValue(value: string) {
      if (cur === value) return;
      cur = value;
      label();
      if (!list.hidden) { render(); setActive(Math.max(0, opts.findIndex((o) => o.value === cur))); }
    },
  });
  label();
  return wrap;
}
