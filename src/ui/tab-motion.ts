import './tab-motion.css';

const DURATION = 150;

interface TabPositions {
  enabled: boolean;
  positions: Map<HTMLElement, DOMRect>;
}

export function createTabMotion(bar: HTMLElement) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const running = new Set<() => void>();
  const cancel = () => { for (const stop of [...running]) stop(); };
  bar.addEventListener('pointerdown', cancel, true);
  reduced?.addEventListener('change', () => { if (reduced.matches) cancel(); });

  const animate = (node: HTMLElement, frames: Keyframe[], cleanup = () => {}) => {
    let animation: Animation;
    try { animation = node.animate(frames, { duration: DURATION, easing: 'cubic-bezier(.2,.7,.3,1)' }); }
    catch { cleanup(); return; }
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      running.delete(stop);
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
      cleanup();
    };
    const timer = setTimeout(stop, DURATION + 80);
    animation.onfinish = stop;
    animation.oncancel = stop;
    running.add(stop);
  };

  return {
    before(nodes: HTMLElement[], changed: boolean, reordered: boolean) {
      const enabled = changed && !reduced?.matches && !document.body.classList.contains('tab-dragging')
        && typeof bar.animate === 'function';
      const positions = enabled ? new Map(nodes.map((node) => [node, node.getBoundingClientRect()])) : new Map<HTMLElement, DOMRect>();
      if (changed || reordered) cancel();
      return { enabled, positions };
    },
    after(previous: TabPositions, nodes: HTMLElement[], removed: HTMLElement[]) {
      if (!previous.enabled) return;
      for (const node of removed) {
        const bounds = previous.positions.get(node);
        if (!bounds) continue;
        const ghost = node.cloneNode(true) as HTMLElement;
        ghost.classList.add('tab-motion-exit');
        ghost.removeAttribute('data-tab-id');
        ghost.removeAttribute('role');
        ghost.removeAttribute('aria-selected');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.inert = true;
        ghost.tabIndex = -1;
        ghost.style.left = `${bounds.left}px`;
        ghost.style.top = `${bounds.top}px`;
        ghost.style.width = `${bounds.width}px`;
        ghost.style.height = `${bounds.height}px`;
        document.body.append(ghost);
        animate(ghost, [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(5px)' }], () => ghost.remove());
      }
      for (const node of nodes) {
        const old = previous.positions.get(node);
        if (!old) animate(node, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }]);
        else {
          const dx = old.left - node.getBoundingClientRect().left;
          if (Math.abs(dx) > .5) animate(node, [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }]);
        }
      }
    },
  };
}
