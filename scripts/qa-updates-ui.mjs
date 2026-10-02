/* global console, process, window, document, performance, URL */
// Browser integration: real About/toolbar/service, with only the native network/opener replaced.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
const dir = 'artifacts/qa-updates-ui';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: 'zh-CN' });
const errors = [];
const checks = [];
page.on('pageerror', error => errors.push(error.message));
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function command(id) {
  await page.evaluate(async id => (await window.__qaImport('/src/core/commands.ts')).executeCommand(id), id);
}
async function result(status, version = '0.2.0') {
  await page.evaluate(async ({ status, version }) => {
    window.__qaResult = {
      status, checkedAt: ++window.__qaTimestamp,
      release: status === 'noReleases' ? null : {
        version, notes: '修复编辑器\nImprove editor\n<img src=x onerror="window.__unsafeRelease=true">',
        url: `https://github.com/yofengi/silk-book/releases/tag/v${version}`,
        asset: status === 'noAsset' ? null : { name: `silk-book-${version}-windows-x64-setup.exe`, url: `https://github.com/yofengi/silk-book/releases/download/v${version}/silk-book-${version}-windows-x64-setup.exe` },
      },
    };
    window.__qaError = null;
    await (await window.__qaImport('/src/core/updates.ts')).checkForUpdates(true);
  }, { status, version });
}
async function transferState(phase, changes = {}) {
  await page.evaluate(({ phase, changes }) => {
    window.__qaTransfer = {
      revision: ++window.__qaTransferRevision, taskId: phase === 'idle' ? null : 'qa-download', phase,
      release: phase === 'idle' ? null : window.__qaPinnedRelease ?? window.__qaResult.release,
      source: 'manual', mode: 'download-only', downloadedBytes: 30, totalBytes: 100, error: null, ...changes,
    };
    window.__qaTransferListener(window.__qaTransfer);
  }, { phase, changes });
}
async function readyNotice() {
  await page.evaluate(() => window.__qaReadyListener({ taskId: window.__qaTransfer.taskId, revision: window.__qaTransfer.revision }));
}
try {
  await page.addInitScript(() => {
    window.__qaTransferRevision = 0;
    window.__qaTransfer = { revision: 0, taskId: null, phase: 'idle', release: null, source: 'manual', mode: 'download-only', downloadedBytes: 0, totalBytes: null, error: null };
    window.__qaDownloads = [];
    window.__qaInstalls = [];
  });
  // Replace only the desktop IPC boundary before the real update service subscribes.
  await page.route('**/src/ipc/mock.ts*', async route => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: `${body}\n
mockIpc.onUpdateTransfer = async fn => { window.__qaTransferListener = fn; };
mockIpc.onUpdateReady = async fn => { window.__qaReadyListener = fn; };
mockIpc.updatesTransfer = async () => window.__qaTransfer;
mockIpc.updateInfo = async () => ({ currentVersion: '0.1.1', platform: 'Windows x64', repositoryUrl: 'https://github.com/yofengi/silk-book', transfer: window.__qaTransfer });
mockIpc.downloadUpdate = async (version, mode) => {
  window.__qaDownloads.push({version,mode}); window.__qaPinnedRelease = window.__qaResult.release;
  window.__qaTransfer = { revision: ++window.__qaTransferRevision, taskId: 'qa-download', phase: 'downloading', release: window.__qaPinnedRelease, source: 'manual', mode, downloadedBytes: 0, totalBytes: 100, error: null };
  window.__qaTransferListener(window.__qaTransfer); return window.__qaTransfer;
};
mockIpc.installUpdate = async taskId => { window.__qaInstalls.push(taskId); if (window.__qaInstallError) throw window.__qaInstallError; };
` });
  });
  await page.goto('http://127.0.0.1:1420');
  await page.waitForSelector('[role=toolbar]');
  await page.evaluate(async () => {
    window.__qaImport = p => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === p)?.name ?? p);
    const settings = await window.__qaImport('/src/core/settings.ts');
    settings.setSetting('workbench.language', 'zh-CN');
    settings.setSetting('workbench.theme', 'glass-dark');
    const { ipc } = await window.__qaImport('/src/ipc/index.ts');
    window.__qaTimestamp = Date.now();
    window.__qaOpened = [];
    ipc.checkUpdates = async () => { if (window.__qaError) throw window.__qaError; return window.__qaResult; };
    ipc.openUpdateLink = async (target, version) => { window.__qaOpened.push({ target, version }); };
  });
  await command('settings.open');
  await page.getByRole('tab', { name: '关于', exact: true }).click();
  await check('About is last, has GitHub icon, version and the default schedule', async () => {
    assert.equal((await page.locator('.st-nav [role=tab]').allTextContents()).at(-1), '关于');
    assert.match(await page.locator('.about-version').innerText(), /0\.1\.1/);
    assert.equal(await page.locator('.about-github svg').count(), 1);
    assert.match(await page.getByRole('combobox', { name: '自动检查间隔', exact: true }).innerText(), /默认/);
    assert.equal(await page.getByRole('switch', { name: '自动更新', exact: true }).getAttribute('aria-checked'), 'false');
    assert.equal(await page.getByRole('combobox', { name: '手动更新', exact: true }).innerText(), '仅下载');
    await page.locator('.about-github').click();
    assert.equal(await page.evaluate(() => window.__qaOpened.at(-1).target), 'repository');
  });
  await check('newer version offers notes and download/ignore actions beneath separator', async () => {
    await result('available');
    await page.locator('.tb-update').click();
    const panel = page.locator('.update-panel');
    await panel.waitFor();
    assert.match(await panel.innerText(), /0\.2\.0/);
    assert.equal(await panel.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__unsafeRelease), undefined);
    const separator = await panel.getByRole('separator').boundingBox();
    const download = await panel.getByRole('button', { name: '下载更新', exact: true }).boundingBox();
    assert.ok(download.y > separator.y);
    await page.screenshot({ path: `${dir}/update-notification.png` });
    await panel.getByRole('button', { name: '下载更新', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__qaDownloads.at(-1)), { mode: 'download-only', version: '0.2.0' });
    assert.equal(await page.evaluate(() => window.__qaOpened.some(item => item.target === 'download')), false);
    await page.keyboard.press('Escape');
    await transferState('idle');
  });
  await check('ignore hides only that version while manual checks remain useful', async () => {
    await page.locator('.tb-update').click();
    await page.locator('.update-panel').getByRole('button', { name: '忽略这次更新', exact: true }).click();
    assert.equal(await page.locator('.tb-update').isVisible(), false);
    await result('available');
    assert.equal(await page.locator('.tb-update').isVisible(), false);
    assert.equal(await page.locator('.st-about').getByRole('button', { name: '下载更新', exact: true }).isVisible(), true);
    await result('available', '0.3.0');
    assert.equal(await page.locator('.tb-update').isVisible(), true);
  });
  await check('missing assets, no release, current release and network errors are distinct', async () => {
    await result('noAsset');
    assert.match(await page.locator('.st-status').innerText(), /没有适用于/);
    assert.equal(await page.locator('.st-about').getByRole('button', { name: '下载更新', exact: true }).isVisible(), false);
    await result('noReleases');
    assert.match(await page.locator('.st-status').innerText(), /尚未发布/);
    await result('current', '0.1.0');
    assert.match(await page.locator('.st-status').innerText(), /已是最新版本/);
    assert.equal(await page.locator('.tb-update').isVisible(), false);
    await page.evaluate(async () => {
      window.__qaError = { kind: 'updateNetwork', message: 'offline' };
      await (await window.__qaImport('/src/core/updates.ts')).checkForUpdates(true);
    });
    assert.match(await page.locator('.st-status').innerText(), /无法连接 GitHub/);
    await page.getByRole('button', { name: '重试', exact: true }).waitFor();
  });
  await check('both progress surfaces stay synchronized without replacing popup or focused nodes', async () => {
    await result('available');
    await page.evaluate(() => { window.__qaPinnedRelease = window.__qaResult.release; });
    await transferState('downloading');
    await page.locator('.tb-update').click();
    await page.locator('.update-panel').getByRole('button', { name: '查看版本页面', exact: true }).focus();
    await page.evaluate(() => { window.__qaPopup = document.querySelector('.update-panel'); window.__qaNotes = document.querySelector('.update-notes'); window.__qaFocused = document.activeElement; });
    await transferState('downloading', { downloadedBytes: 45 });
    assert.equal(await page.locator('.st-about progress').getAttribute('value'), '45');
    assert.equal(await page.locator('.update-panel progress').getAttribute('value'), '45');
    assert.match(await page.locator('.tb-update').getAttribute('aria-label'), /45%/);
    assert.equal(await page.evaluate(() => window.__qaPopup === document.querySelector('.update-panel') && window.__qaNotes === document.querySelector('.update-notes') && window.__qaFocused === document.activeElement), true);
    await page.screenshot({ path: `${dir}/shared-progress.png` });
  });
  await check('unknown totals stay indeterminate and stale snapshots do not regress progress', async () => {
    await transferState('downloading', { downloadedBytes: 65, totalBytes: null });
    assert.equal(await page.locator('.st-about progress').getAttribute('value'), null);
    assert.equal(await page.locator('.update-panel progress').getAttribute('value'), null);
    await page.evaluate(() => window.__qaTransferListener({ ...window.__qaTransfer, revision: 0, downloadedBytes: 1, totalBytes: 100 }));
    assert.equal(await page.locator('.st-about progress').getAttribute('value'), null);
    assert.match(await page.locator('.st-about .update-progress-text').innerText(), /65 B/);
  });
  await check('a newer checked release does not replace the downloading package or notes', async () => {
    await result('available', '0.3.0');
    assert.match(await page.locator('.update-heading').innerText(), /0\.2\.0/);
    assert.match(await page.locator('.st-status').innerText(), /0\.2\.0/);
  });
  await check('download-only completion waits for a click and exposes Install update in both surfaces', async () => {
    await page.keyboard.press('Escape');
    await transferState('ready');
    assert.equal(await page.locator('.update-panel').count(), 0);
    assert.equal(await page.evaluate(() => window.__qaInstalls.length), 0);
    await page.locator('.tb-update').click();
    assert.equal(await page.locator('.update-panel').getByRole('button', { name: '安装更新', exact: true }).isVisible(), true);
    assert.equal(await page.locator('.st-about').getByRole('button', { name: '安装更新', exact: true }).isVisible(), true);
    assert.equal(await page.locator('.update-panel').getByRole('button', { name: '忽略这次更新', exact: true }).isVisible(), false);
    await page.keyboard.press('Escape');
  });
  await check('download-and-install prompts once and starts installation only on explicit action', async () => {
    await transferState('idle');
    await page.evaluate(async () => { (await window.__qaImport('/src/core/updates.ts')).setManualUpdateMode('download-and-install'); });
    await page.locator('.st-about').getByRole('button', { name: '下载更新', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__qaDownloads.at(-1).mode), 'download-and-install');
    await transferState('ready', { taskId: 'qa-install-prompt', mode: 'download-and-install' });
    assert.equal(await page.locator('.update-panel').count(), 0);
    await readyNotice();
    const install = page.locator('.update-panel').getByRole('button', { name: '安装并重启', exact: true });
    await install.waitFor();
    assert.equal(await page.evaluate(() => window.__qaInstalls.length), 0);
    await page.screenshot({ path: `${dir}/ready-install.png` });
    await page.keyboard.press('Escape');
    await readyNotice();
    assert.equal(await page.locator('.update-panel').count(), 0);
    await page.locator('.tb-update').click();
    await install.click();
    assert.deepEqual(await page.evaluate(() => window.__qaInstalls), ['qa-install-prompt']);
  });
  await check('installation failure keeps the ready package with a retry action', async () => {
    await transferState('ready', { taskId: 'qa-install-prompt', mode: 'download-and-install', error: { kind: 'updateInstall', message: 'launch failed' } });
    assert.equal(await page.locator('.update-panel').getByRole('button', { name: '重试安装', exact: true }).isVisible(), true);
    assert.match(await page.locator('.about-update-error').innerText(), /安装未能开始/);
    await page.keyboard.press('Escape');
  });
  await check('automatic download completion prompts in its targeted window but never auto-installs', async () => {
    await transferState('ready', { taskId: 'qa-automatic', source: 'automatic', mode: 'download-only' });
    assert.equal(await page.locator('.update-panel').count(), 0);
    await readyNotice();
    await page.locator('.update-panel').getByRole('button', { name: '安装更新', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__qaInstalls.length), 1);
    await page.keyboard.press('Escape');
  });
  await check('new update settings persist and frozen commands close dropdowns and disable actions', async () => {
    await page.getByRole('switch', { name: '自动更新', exact: true }).click();
    assert.equal(await page.getByRole('switch', { name: '自动更新', exact: true }).getAttribute('aria-checked'), 'true');
    await page.getByRole('combobox', { name: '手动更新', exact: true }).click();
    await page.getByRole('option', { name: '仅下载', exact: true }).click();
    await page.getByRole('combobox', { name: '手动更新', exact: true }).click();
    await page.evaluate(async () => { (await window.__qaImport('/src/core/commands.ts')).setCommandExecutionBlocked(true); });
    assert.equal(await page.getByRole('listbox').isVisible(), false);
    assert.equal(await page.getByRole('switch', { name: '自动更新', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('combobox', { name: '手动更新', exact: true }).isDisabled(), true);
    await page.evaluate(async () => { (await window.__qaImport('/src/core/commands.ts')).setCommandExecutionBlocked(false); });
    assert.equal(await page.getByRole('switch', { name: '自动更新', exact: true }).isDisabled(), false);
  });
  await check('all four languages fit About at minimum supported width', async () => {
    await result('available', '0.3.0');
    await page.setViewportSize({ width: 640, height: 400 });
    for (const language of ['zh-CN', 'en', 'zh-TW', 'ja']) {
      await page.evaluate(async language => {
        (await window.__qaImport('/src/core/settings.ts')).setSetting('workbench.language', language);
      }, language);
      await page.waitForFunction(language => window.document.documentElement.lang === language, language);
      assert.equal(await page.locator('.st-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, language);
      await page.screenshot({ path: `${dir}/about-${language}.png` });
    }
  });
  await check('no uncaught frontend exceptions', () => assert.deepEqual(errors, []));
  await writeFile(`${dir}/results.json`, JSON.stringify({ checks, errors }, null, 2));
} finally { await browser.close(); }
