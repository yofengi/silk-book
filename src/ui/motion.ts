export type MotionPreset = 'popup' | 'popup-up' | 'submenu' | 'panel' | 'fade';

interface RunningMotion {
  phase: 'enter' | 'exit';
  finish(): void;
}

const running = new WeakMap<HTMLElement, RunningMotion>();
const OFFSET: Record<MotionPreset, string> = {
  popup: '0 -4px',
  'popup-up': '0 4px',
  submenu: '-3px 0',
  panel: '0 -6px',
  fade: '0 0',
};

function mediaQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
}

function animate(element: HTMLElement, frames: Keyframe[], phase: RunningMotion['phase'], media: MediaQueryList | null): () => void {
  const duration = phase === 'enter' ? 160 : 120;
  let animation: Animation;
  try {
    animation = element.animate(frames, { duration, easing: phase === 'enter' ? 'cubic-bezier(.2,.7,.2,1)' : 'ease-in', fill: 'both' });
  } catch {
    if (phase === 'exit') element.remove();
    return () => {};
  }
  let settled = false;
  const onReducedMotion = (event: MediaQueryListEvent) => { if (event.matches) finish(); };
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    animation.removeEventListener('finish', finish);
    animation.removeEventListener('cancel', finish);
    if (media?.removeEventListener) media.removeEventListener('change', onReducedMotion);
    else media?.removeListener(onReducedMotion);
    if (running.get(element)?.finish === finish) running.delete(element);
    animation.cancel();
    if (phase === 'exit') element.remove();
  };
  running.set(element, { phase, finish });
  animation.addEventListener('finish', finish);
  animation.addEventListener('cancel', finish);
  if (media?.addEventListener) media.addEventListener('change', onReducedMotion);
  else media?.addListener(onReducedMotion);
  const timer = setTimeout(finish, duration + 80);
  return finish;
}

export function motionEnter(element: HTMLElement, preset: MotionPreset = 'popup'): void {
  if (running.has(element)) return;
  const media = mediaQuery();
  if (media?.matches || typeof element.animate !== 'function' || !element.isConnected) return;
  animate(element, [{ opacity: 0, translate: OFFSET[preset] }, { opacity: 1, translate: '0 0' }], 'enter', media);
}

export function motionRemove(element: HTMLElement, preset: MotionPreset = 'popup'): () => void {
  const current = running.get(element);
  if (current?.phase === 'exit') return current.finish;
  const media = mediaQuery();
  if (media?.matches || typeof element.animate !== 'function' || !element.isConnected) {
    running.get(element)?.finish();
    element.remove();
    return () => {};
  }
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
  const opacity = style?.opacity ?? '1';
  const translate = !style?.translate || style.translate === 'none' ? '0 0' : style.translate;
  running.get(element)?.finish();
  const focused = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
  if (focused && element.contains(focused) && typeof focused.blur === 'function') focused.blur();
  element.inert = true;
  element.setAttribute('aria-hidden', 'true');
  element.style.pointerEvents = 'none';
  for (const node of [element, ...element.querySelectorAll<HTMLElement>('[id], [aria-modal]')]) {
    node.removeAttribute('id');
    node.removeAttribute('aria-modal');
  }
  return animate(element, [{ opacity, translate }, { opacity: 0, translate: OFFSET[preset] }], 'exit', media);
}
