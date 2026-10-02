import './about.css';
import { executeCommand, isCommandExecutionBlocked } from '../core/commands';
import { events } from '../core/events';
import { getSetting } from '../core/settings';
import { getUpdateRelease, getUpdateState, isUpdateTransferBusy, setAutoDownload, setManualUpdateMode, setUpdateInterval } from '../core/updates';
import { getLocale, productName, t } from '../i18n';
import { createUpdateProgress } from '../ui/update-progress';
import { updateErrorText, updateResultText, updateTransferText } from '../ui/update-text';
import { button, group, h, row, select, statusLine, toggle } from './dom';

const GITHUB_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.5v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.6-1.3-1.6-1.1-.8.1-.8.1-.8 1.2.1 1.9 1.2 1.9 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.4-5.5-6.2 0-1.4.5-2.5 1.3-3.4-.1-.3-.6-1.6.1-3.3 0 0 1-.3 3.5 1.3a12 12 0 0 1 6.4 0c2.5-1.6 3.5-1.3 3.5-1.3.7 1.7.2 3 .1 3.3.8.9 1.3 2 1.3 3.4 0 4.8-2.8 5.9-5.5 6.2.4.4.8 1.1.8 2.3v3.1c0 .3.2.6.8.5A11.4 11.4 0 0 0 12 .8Z"/></svg>';

export function renderAbout(): { el: HTMLElement; dispose(): void } {
  const github = button('', () => { void executeCommand('updates.repository'); }, 'st-btn about-github');
  github.title = t('about.github');
  github.setAttribute('aria-label', t('about.github'));
  github.innerHTML = GITHUB_ICON;
  const version = h('p', { class: 'about-version' });
  const header = h('div', { class: 'about-header' },
    h('div', { class: 'about-brand' }, h('h2', { text: productName() }), version), github);
  const check = button(t('updates.check'), () => { void executeCommand('updates.check'); }, 'st-btn primary');
  const download = button(t('updates.download'), () => { void executeCommand('updates.download'); }, 'st-btn primary');
  const install = button(t('updates.installRestart'), () => { void executeCommand('updates.install'); }, 'st-btn primary');
  const releasePage = button(t('updates.releasePage'), () => { void executeCommand('updates.release'); });
  const result = statusLine();
  const lastChecked = h('p', { class: 'st-hint about-last-checked' });
  const ignored = h('p', { class: 'st-hint', text: t('updates.ignored') });
  const installHelp = h('p', { class: 'st-hint', text: t('updates.installHelp') });
  const progress = createUpdateProgress();
  const transferError = h('p', { class: 'about-update-error', attrs: { role: 'status' } });
  const notes = h('pre', { class: 'about-release-notes' });
  const notesGroup = h('section', { class: 'about-notes' }, h('h3', { text: t('updates.notes') }), notes, ignored);
  const intervals = select([
    { value: '24', label: t('updates.intervals.day') },
    { value: '1', label: t('updates.intervals.hour') },
    { value: '168', label: t('updates.intervals.week') },
    { value: '720', label: t('updates.intervals.month') },
  ], String(getSetting('updates.intervalHours')), (value) => setUpdateInterval(Number(value)));
  const intervalButton = intervals.querySelector<HTMLButtonElement>('button');
  const automatic = toggle(getSetting('updates.autoDownload'), setAutoDownload);
  const manualMode = select([
    { value: 'download-only', label: t('updates.downloadOnly') },
    { value: 'download-and-install', label: t('updates.downloadAndInstall') },
  ], getSetting('updates.manualMode'), setManualUpdateMode);
  const modeButton = manualMode.querySelector<HTMLButtonElement>('button');
  const el = h('div', { class: 'st-about' }, header,
    group(t('updates.title'), null,
      h('div', { class: 'about-actions' }, check), result.el, progress.el, transferError,
      h('div', { class: 'about-actions' }, download, install, releasePage), installHelp, lastChecked, notesGroup,
    ),
    group(t('updates.settings'), null,
      row(t('updates.autoDownload'), automatic, t('updates.autoDownloadHelp')),
      row(t('updates.manualMode'), manualMode, t('updates.manualModeHelp')),
      row(t('updates.interval'), intervals),
      h('p', { class: 'st-hint', text: t('updates.intervalHelp') }),
    ));

  const render = () => {
    const state = getUpdateState();
    const blocked = isCommandExecutionBlocked();
    version.textContent = t('about.version', { version: state.info?.currentVersion ?? '—' });
    github.disabled = blocked;
    check.disabled = blocked || state.checking;
    check.textContent = state.checking ? t('updates.checking') : state.errorKind ? t('updates.retry') : t('updates.check');
    const transfer = state.transfer;
    const phase = transfer?.phase ?? 'idle';
    const hasTransfer = !!transfer?.taskId && phase !== 'idle';
    result.set(hasTransfer ? updateTransferText(transfer!) : state.checking ? t('updates.checking') : state.errorKind ? updateErrorText(state.errorKind)
      : state.result ? updateResultText(state.result, state.info?.platform ?? '—') : t('updates.idle'),
    phase === 'error' || (!hasTransfer && state.errorKind && !state.checking) ? 'error' : phase === 'ready' || state.result?.status === 'current' ? 'ok' : '');
    progress.render(transfer);
    const transferErrorKind = transfer?.error?.kind ?? state.transferErrorKind;
    transferError.hidden = !transferErrorKind || phase === 'error';
    if (transferErrorKind) transferError.textContent = updateErrorText(transferErrorKind);
    const release = getUpdateRelease();
    const showRelease = !!release && (hasTransfer || state.result?.status === 'available' || state.result?.status === 'noAsset');
    download.hidden = !showRelease || !release?.asset || isUpdateTransferBusy() || phase === 'ready';
    download.textContent = t(phase === 'error' || (state.transferErrorKind && !hasTransfer) ? 'updates.retryDownload' : 'updates.download');
    install.hidden = phase !== 'ready';
    install.disabled = blocked || state.requestingInstall;
    install.textContent = t(transfer?.error || state.transferErrorKind ? 'updates.retryInstall'
      : transfer?.mode === 'download-and-install' ? 'updates.installRestart' : 'updates.install');
    releasePage.hidden = !showRelease;
    download.disabled = blocked || state.startingDownload || !release?.asset;
    releasePage.disabled = blocked || !release;
    installHelp.hidden = !showRelease || !release?.asset;
    notesGroup.hidden = !showRelease;
    const notesText = release?.notes || t('updates.noNotes');
    if (notes.textContent !== notesText) notes.textContent = notesText;
    ignored.hidden = !showRelease || release?.version !== getSetting('updates.ignoredVersion');
    const checkedAt = state.result?.checkedAt ?? getSetting('updates.lastCheckedAt');
    const date = new Date(checkedAt);
    lastChecked.hidden = checkedAt <= 0 || !Number.isFinite(date.valueOf());
    if (!lastChecked.hidden) lastChecked.textContent = t('updates.lastChecked', {
      time: new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date),
    });
    intervals.setValue(String(getSetting('updates.intervalHours')));
    manualMode.setValue(getSetting('updates.manualMode'));
    automatic.setAttribute('aria-checked', String(getSetting('updates.autoDownload')));
    automatic.disabled = blocked;
    if (modeButton) modeButton.disabled = blocked;
    if (intervalButton) intervalButton.disabled = blocked;
    if (blocked) {
      for (const dropdown of [intervals, manualMode]) {
        const list = dropdown.querySelector<HTMLElement>('[role="listbox"]');
        if (list) list.hidden = true;
        const control = dropdown.querySelector<HTMLButtonElement>('button');
        control?.setAttribute('aria-expanded', 'false');
        control?.removeAttribute('aria-activedescendant');
      }
    }
  };
  const off = [events.on('updates.changed', render), events.on('commands.executionChanged', render)];
  render();
  return { el, dispose() { off.forEach((dispose) => dispose()); } };
}
