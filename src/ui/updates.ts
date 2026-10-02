import './updates.css';
import { executeCommand, isCommandExecutionBlocked, registerCommand } from '../core/commands';
import { events } from '../core/events';
import { getUpdateNotification, getUpdateState } from '../core/updates';
import { t } from '../i18n';
import { createUpdateProgress } from './update-progress';
import { updateErrorText, updateResultText, updateTransferPercent, updateTransferText } from './update-text';

const DOWNLOAD_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2v7m-3-3 3 3 3-3M3 10v3h10v-3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let button: HTMLButtonElement | null = null;
let panel: HTMLElement | null = null;
let panelVersion = '';
let panelNodes: ReturnType<typeof buildPanel> | null = null;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function text(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function closePanel(returnFocus = false): void {
  panel?.remove();
  panel = null;
  panelNodes = null;
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

function buildPanel(root: HTMLElement) {
  const heading = element('h2', 'update-heading');
  heading.id = 'update-panel-title';
  const description = element('p', 'update-description');
  description.setAttribute('role', 'status');
  const progress = createUpdateProgress();
  const notesLabel = element('h3', 'update-notes-label');
  const notes = element('pre', 'update-notes');
  const divider = element('div', 'menu-sep');
  divider.setAttribute('role', 'separator');
  const actions = element('div', 'update-actions');
  const action = (command: string, primary = false) => {
    const node = element('button', `update-action${primary ? ' primary' : ''}`);
    node.type = 'button';
    node.addEventListener('click', () => { if (!isCommandExecutionBlocked()) void executeCommand(command); });
    return node;
  };
  const download = action('updates.download', true);
  const install = action('updates.install', true);
  const releasePage = action('updates.release');
  const ignore = action('updates.ignore');
  actions.append(download, install, releasePage, ignore);
  const hint = element('p', 'update-hint');
  const error = element('p', 'update-error');
  error.setAttribute('role', 'status');
  root.append(heading, description, progress.el, notesLabel, notes, divider, actions, hint, error);
  return { heading, description, progress, notesLabel, notes, download, install, releasePage, ignore, hint, error };
}

function renderPanel(): void {
  const result = getUpdateNotification();
  const release = result?.release;
  if (!panel || !panelNodes || !result || !release) { closePanel(); return; }
  const nodes = panelNodes;
  const state = getUpdateState();
  const transfer = state.transfer;
  const phase = transfer?.phase ?? 'idle';
  const hasTransfer = !!transfer?.taskId && phase !== 'idle';
  const busy = ['downloading', 'verifying', 'preparingInstall', 'installing'].includes(phase);
  const blocked = isCommandExecutionBlocked();
  text(nodes.heading, t('updates.available', { version: release.version }));
  text(nodes.description, hasTransfer ? updateTransferText(transfer!) : updateResultText(result, state.info?.platform ?? '—'));
  nodes.progress.render(transfer ?? null);
  text(nodes.notesLabel, t('updates.notes'));
  // Do not reset selected release notes on each progress tick. Markdown/HTML stays inert.
  text(nodes.notes, release.notes || t('updates.noNotes'));
  nodes.download.hidden = !release.asset || busy || phase === 'ready';
  nodes.download.disabled = blocked || !!state.startingDownload;
  text(nodes.download, t(phase === 'error' || (state.transferErrorKind && !hasTransfer) ? 'updates.retryDownload' : 'updates.download'));
  nodes.install.hidden = phase !== 'ready';
  nodes.install.disabled = blocked || !!state.requestingInstall;
  text(nodes.install, t(transfer?.error || state.transferErrorKind ? 'updates.retryInstall'
    : transfer?.mode === 'download-and-install' ? 'updates.installRestart' : 'updates.install'));
  nodes.releasePage.disabled = blocked;
  text(nodes.releasePage, t('updates.releasePage'));
  nodes.ignore.hidden = hasTransfer;
  nodes.ignore.disabled = blocked;
  text(nodes.ignore, t('updates.ignore'));
  text(nodes.hint, release.asset ? t('updates.installHelp') : t('updates.noAsset', { version: release.version, platform: state.info?.platform ?? '—' }));
  const kind = transfer?.error?.kind ?? state.transferErrorKind ?? (state.errorKind === 'updateOpen' ? state.errorKind : null);
  nodes.error.hidden = !kind || phase === 'error';
  if (kind) text(nodes.error, updateErrorText(kind));
  positionPanel();
}

function showPanel(focus = true): void {
  if (isCommandExecutionBlocked() || !getUpdateNotification() || !button) return;
  if (panel) { renderPanel(); return; }
  panel = element('section', 'menu update-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'update-panel-title');
  panel.tabIndex = -1;
  panelVersion = getUpdateNotification()?.release?.version ?? '';
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePanel(true); }
  });
  panelNodes = buildPanel(panel);
  document.body.append(panel);
  renderPanel();
  button.setAttribute('aria-expanded', 'true');
  if (focus) panel?.focus();
}

function togglePanel(): void {
  if (panel) closePanel(true);
  else showPanel();
}

export function createUpdateButton(): HTMLButtonElement {
  registerCommand({ id: 'updates.show', title: () => t('updates.notes'), run: togglePanel, when: () => !!getUpdateNotification() });
  button = element('button', 'tb-btn tb-update');
  button.type = 'button';
  button.dataset.command = 'updates.show';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  const icon = element('span', 'update-icon');
  icon.innerHTML = DOWNLOAD_ICON;
  const badge = element('span', 'update-badge');
  badge.setAttribute('aria-hidden', 'true');
  button.append(icon, badge);
  button.addEventListener('click', () => { void executeCommand('updates.show'); });
  const render = () => {
    if (!button) return;
    const result = getUpdateNotification();
    const transfer = getUpdateState().transfer;
    const busy = !!transfer && ['downloading', 'verifying', 'preparingInstall', 'installing'].includes(transfer.phase);
    const label = transfer?.taskId && transfer.phase !== 'idle' ? updateTransferText(transfer)
      : result?.release ? t('updates.available', { version: result.release.version }) : t('updates.notes');
    button.hidden = !result;
    button.disabled = isCommandExecutionBlocked();
    button.title = label;
    button.setAttribute('aria-label', label);
    button.classList.toggle('update-busy', busy);
    const percent = transfer && transfer.phase === 'downloading' ? updateTransferPercent(transfer) : null;
    badge.hidden = !busy;
    text(badge, percent === null ? '…' : `${percent}%`);
    if (!result || button.disabled || (panel && result.release?.version !== panelVersion)) closePanel();
    else if (panel) renderPanel();
  };
  events.on('updates.changed', render);
  events.on('locale.changed', render);
  events.on('commands.executionChanged', render);
  events.on('updates.ready', ({ taskId }) => {
    if (getUpdateState().transfer?.taskId === taskId && getUpdateState().transfer?.phase === 'ready') showPanel(false);
  });
  document.addEventListener('pointerdown', (event) => {
    if (panel && !panel.contains(event.target as Node) && !button?.contains(event.target as Node)) closePanel();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && panel) closePanel(true); });
  window.addEventListener('resize', () => closePanel());
  render();
  return button;
}
