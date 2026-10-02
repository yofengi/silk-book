import './updates.css';
import { executeCommand, isCommandExecutionBlocked, registerCommand } from '../core/commands';
import { events } from '../core/events';
import { getUpdateNotification, getUpdateState } from '../core/updates';
import { t } from '../i18n';
import { updateErrorText, updateResultText } from './update-text';

const DOWNLOAD_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2v7m-3-3 3 3 3-3M3 10v3h10v-3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let button: HTMLButtonElement | null = null;
let panel: HTMLElement | null = null;
let panelVersion = '';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function closePanel(returnFocus = false): void {
  panel?.remove();
  panel = null;
  panelVersion = '';
  button?.setAttribute('aria-expanded', 'false');
  if (returnFocus && button && !button.hidden && !button.disabled) button.focus();
}

function positionPanel(): void {
  if (!panel || !button) return;
  const rect = button.getBoundingClientRect();
  panel.style.left = `${Math.max(6, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 6))}px`;
  panel.style.top = `${Math.max(6, Math.min(rect.bottom + 6, window.innerHeight - panel.offsetHeight - 6))}px`;
}

function renderPanel(): void {
  const result = getUpdateNotification();
  const release = result?.release;
  if (!panel || !result || !release) { closePanel(); return; }
  const heading = element('h2', 'update-heading', t('updates.available', { version: release.version }));
  heading.id = 'update-panel-title';
  const description = element('p', 'update-description', updateResultText(result, getUpdateState().info?.platform ?? '—'));
  const notesLabel = element('h3', 'update-notes-label', t('updates.notes'));
  const notes = element('pre', 'update-notes', release.notes || t('updates.noNotes'));
  // Release Markdown/HTML is inert text; untrusted links are never forwarded to the opener.
  const divider = element('div', 'menu-sep');
  divider.setAttribute('role', 'separator');
  const actions = element('div', 'update-actions');
  const download = element('button', 'update-action primary', t(release.asset ? 'updates.download' : 'updates.releasePage'));
  download.type = 'button';
  download.addEventListener('click', () => {
    if (isCommandExecutionBlocked()) return;
    void executeCommand(release.asset ? 'updates.download' : 'updates.release').then((opened) => {
      if (opened) closePanel(true);
    });
  });
  const ignore = element('button', 'update-action', t('updates.ignore'));
  ignore.type = 'button';
  ignore.addEventListener('click', () => { void executeCommand('updates.ignore'); });
  actions.append(download, ignore);
  const hint = element('p', 'update-hint', release.asset ? t('updates.browserHelp') : t('updates.noAsset', {
    version: release.version, platform: getUpdateState().info?.platform ?? '—',
  }));
  const error = element('p', 'update-error');
  error.setAttribute('role', 'status');
  const kind = getUpdateState().errorKind;
  error.hidden = kind !== 'updateOpen';
  if (kind === 'updateOpen') error.textContent = updateErrorText(kind);
  panel.replaceChildren(heading, description, notesLabel, notes, divider, actions, hint, error);
  positionPanel();
}

function togglePanel(): void {
  if (isCommandExecutionBlocked() || !getUpdateNotification() || !button) return;
  if (panel) { closePanel(true); return; }
  panel = element('section', 'menu update-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'update-panel-title');
  panel.tabIndex = -1;
  panelVersion = getUpdateNotification()?.release?.version ?? '';
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePanel(true); }
  });
  document.body.append(panel);
  renderPanel();
  button.setAttribute('aria-expanded', 'true');
  panel?.focus();
}

export function createUpdateButton(): HTMLButtonElement {
  registerCommand({ id: 'updates.show', title: () => t('updates.notes'), run: togglePanel, when: () => !!getUpdateNotification() });
  button = element('button', 'tb-btn tb-update');
  button.type = 'button';
  button.dataset.command = 'updates.show';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = DOWNLOAD_ICON;
  button.addEventListener('click', () => { void executeCommand('updates.show'); });
  const render = () => {
    if (!button) return;
    const result = getUpdateNotification();
    button.hidden = !result;
    button.disabled = isCommandExecutionBlocked();
    const label = result?.release ? t('updates.available', { version: result.release.version }) : t('updates.notes');
    button.title = label;
    button.setAttribute('aria-label', label);
    if (!result || button.disabled || (panel && result.release?.version !== panelVersion)) closePanel();
    else if (panel) renderPanel();
  };
  events.on('updates.changed', render);
  events.on('locale.changed', render);
  events.on('commands.executionChanged', render);
  document.addEventListener('pointerdown', (event) => {
    if (panel && !panel.contains(event.target as Node) && !button?.contains(event.target as Node)) closePanel();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && panel) closePanel(true); });
  window.addEventListener('resize', () => closePanel());
  render();
  return button;
}
