// Minimal DOM for menu event regressions; layout is verified separately in the browser.
export function testDom() {
  const document = { activeElement: null };
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.style = {};
      this.attrs = {};
      this.listeners = new Map();
      this.className = '';
      this.hidden = false;
      this.offsetWidth = 200;
      this.offsetHeight = 100;
      this.clientWidth = 400;
      this.scrollWidth = 100;
      this.classList = {
        contains: (name) => this.className.split(' ').includes(name),
        add: (name) => { if (!this.className.split(' ').includes(name)) this.className += ` ${name}`; },
        remove: (name) => { this.className = this.className.split(' ').filter((word) => word !== name).join(' '); },
        toggle: (name, on) => { this.classList[on ? 'add' : 'remove'](name); },
      };
    }
    get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    append(...elements) { for (const element of elements) { element.parentElement = this; this.children.push(element); } }
    replaceChildren(...elements) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...elements); }
    remove() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
    getBoundingClientRect() { return { left: 4, right: 204, top: 300, bottom: 330 }; }
    querySelectorAll(selector) {
      if (selector.startsWith(':scope')) return this.children.filter((child) => {
        const role = child.getAttribute('role');
        if (role !== 'menuitem' && role !== 'menuitemradio') return false;
        return role === 'menuitemradio' || child.getAttribute('aria-disabled') !== 'true';
      });
      return [];
    }
    focus() { document.activeElement = this; }
    addEventListener(type, fn) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(fn);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== fn)); }
    dispatchEvent(event) {
      event.target ??= this;
      for (const handler of this.listeners.get(event.type) ?? []) handler(event);
      return true;
    }
    click() { this.dispatchEvent({ type: 'click', detail: 1, preventDefault() {}, stopPropagation() {} }); }
  }
  document.body = new Element('body');
  document.createElement = (tag) => new Element(tag);
  document.querySelector = () => null;
  document.addEventListener = () => {};
  document.removeEventListener = () => {};
  const window = { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} };
  return { document, window, HTMLElement: Element, ResizeObserver: class { observe() {} } };
}
