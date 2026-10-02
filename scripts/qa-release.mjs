/* global process, console, window, setTimeout */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:9223'); }
  catch { await new Promise(resolve => setTimeout(resolve, 250)); }
}
assert.ok(browser, 'release CDP unavailable');
const context = browser.contexts()[0];
const page = context.pages()[0];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.waitForSelector('[role=toolbar]');
  assert.ok(!page.url().includes(':1420'), 'release unexpectedly uses the development server');
  await page.keyboard.press('Control+,');
  await page.waitForSelector('.settings-page');
  assert.equal(await page.locator('.st-general [role=switch]').count(), 9);
  assert.equal(await page.locator('.st-general [role=combobox]').count(), 5);
  const language = page.locator('.st-general [role=combobox]').last();
  await language.scrollIntoViewIfNeeded();
  await language.click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => window.document.title === 'silk book');
  assert.equal(await page.locator('.st-title').innerText(), 'General');
  await page.screenshot({ path: 'artifacts/qa-release/release-settings.png' });
  await page.keyboard.press('Control+n');
  await page.locator('.cm-content').click();
  await page.keyboard.type('Release smoke check');
  assert.equal(await page.locator('.cm-line').first().innerText(), 'Release smoke check');
  await page.keyboard.press('Control+f');
  await page.waitForSelector('.cm-search');
  assert.ok((await page.locator('.cm-search').innerText()).toLowerCase().includes('replace'));
  assert.deepEqual(errors, []);
  console.log('PASS release executable: embedded frontend, General controls, lazy English locale, editor input and search; no page exceptions');
} finally {
  for (const target of context.pages()) {
    await target.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label })).catch(() => {});
  }
  await browser.close();
}
