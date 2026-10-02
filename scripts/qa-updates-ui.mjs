/* global console, process, window, performance, URL */
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
try {
  await page.goto('http://127.0.0.1:1420');
  await page.waitForSelector('[role=toolbar]');
  await page.evaluate(async () => {
    window.__qaImport = p => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === p)?.name ?? p);
    const settings = await window.__qaImport('/src/core/settings.ts');
    settings.setSetting('workbench.language', 'zh-CN');
    settings.setSetting('workbench.theme', 'glass-dark');
    const updates = await window.__qaImport('/src/core/updates.ts');
    updates.stopUpdateService();
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
    assert.match(await page.locator('.about-version').innerText(), /0\.1\.0/);
    assert.equal(await page.locator('.about-github svg').count(), 1);
    assert.match(await page.locator('.st-about [role=combobox]').innerText(), /默认/);
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
    assert.deepEqual(await page.evaluate(() => window.__qaOpened.at(-1)), { target: 'download', version: '0.2.0' });
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
