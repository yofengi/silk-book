/* global console, process, window, document, performance, URL, AbortController, HTMLDialogElement, HTMLElement, getComputedStyle, KeyboardEvent, InputEvent */
// Real browser integration, including the actual capturing application keybindings.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
const dir = 'artifacts/qa-confirm-dialog';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: 'zh-CN' });
const checks = [];
const errors = [];
const systemDialogs = [];
const modal = page.locator('dialog.confirm-dialog[open], .confirm-dialog-overlay .confirm-dialog');
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', async dialog => { systemDialogs.push(dialog.type()); await dialog.dismiss(); });
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function open(id, message = '放弃未保存的修改？\nDiscard unsaved changes?', options = {}) {
  await page.evaluate(async ({ id, message, options }) => {
    const { ipc } = await window.__qaImport('/src/ipc/index.ts');
    const controller = new AbortController();
    window.__confirmControllers[id] = controller;
    if (options.aborted) controller.abort();
    ipc.confirm(message, options.title, { signal: controller.signal }).then(answer => { window.__confirmAnswers[id] = answer; });
  }, { id, message, options });
}
async function answer(id, expected) {
  await page.waitForFunction(id => Object.hasOwn(window.__confirmAnswers, id), id);
  assert.equal(await page.evaluate(id => window.__confirmAnswers[id], id), expected);
}
async function unresolved(id) {
  assert.equal(await page.evaluate(id => Object.hasOwn(window.__confirmAnswers, id), id), false);
}
async function abort(id) { await page.evaluate(id => window.__confirmControllers[id].abort(), id); }
async function theme(value) { await page.evaluate(async value => (await window.__qaImport('/src/core/settings.ts')).setSetting('workbench.theme', value), value); }
async function freeze(value) {
  await page.evaluate(async value => {
    document.body.inert = value;
    (await window.__qaImport('/src/core/commands.ts')).setCommandExecutionBlocked(value);
  }, value);
}
async function focused(selector) { assert.equal(await page.locator(selector).evaluate(el => el === document.activeElement), true); }
try {
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:1420');
  await page.waitForSelector('[role=toolbar]');
  await page.evaluate(async () => {
    // Reuse the modules Vite actually loaded, including their HMR URLs.
    window.__qaImport = p => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === p)?.name ?? p);
    window.__confirmAnswers = {};
    window.__confirmControllers = {};
    // The empty editor is a read-only placeholder until a document is opened.
    await (await window.__qaImport('/src/core/commands.ts')).executeCommand('file.new');
  });
  await check('confirmations inherit glass, light and dark themes without rebuilding the open modal', async () => {
    await open('themes');
    await modal.waitFor();
    await modal.evaluate(el => { window.__confirmFirstElement = el; });
    const observed = [];
    for (const name of ['glass-dark', 'glass-light', 'light', 'dark']) {
      await theme(name);
      const style = await modal.evaluate(el => {
        const css = getComputedStyle(el);
        return { same: el === window.__confirmFirstElement, kind: document.documentElement.dataset.theme, glass: document.documentElement.hasAttribute('data-glass'), bg: css.backgroundColor, filter: css.backdropFilter, font: css.fontFamily, bodyFont: getComputedStyle(document.body).fontFamily };
      });
      assert.equal(style.same, true);
      assert.equal(style.kind, name.endsWith('dark') ? 'dark' : 'light');
      assert.equal(style.glass, name.startsWith('glass'));
      assert.equal(style.font, style.bodyFont);
      if (style.glass) assert.match(style.filter, /blur/);
      else assert.equal(style.filter, 'none');
      observed.push(style.bg);
      await page.screenshot({ path: `${dir}/${name}.png` });
    }
    assert.notEqual(observed[2], observed[3]);
    await page.locator('.confirm-dialog-cancel').click();
    await answer('themes', false);
  });
  await check('a parsed custom theme and configured UI font apply to the modal and buttons', async () => {
    await page.evaluate(async () => {
      const { ipc } = await window.__qaImport('/src/ipc/index.ts');
      window.__confirmOriginalThemes = ipc.themesList;
      ipc.themesList = async () => [{ id: 'confirm-qa', fileName: 'confirm-qa.json', json: { name: 'Confirm QA', kind: 'dark', glass: false, colors: { '--editor-bg': '#182532', '--fg': '#e8d5b1', '--accent': '#9072db', '--accent-fg': '#ffffff', '--focus': '#9072db', '--border': '#485d6b' } } }];
      await (await window.__qaImport('/src/themes/index.ts')).reloadUserThemes();
      const settings = await window.__qaImport('/src/core/settings.ts');
      settings.setSetting('workbench.theme', 'user:confirm-qa');
      settings.setSetting('workbench.fontFamily', 'Georgia');
      settings.setSetting('workbench.fontSize', 15);
    });
    await open('custom');
    await modal.waitFor();
    const style = await modal.evaluate(el => {
      const css = getComputedStyle(el);
      const accept = getComputedStyle(el.querySelector('.confirm-dialog-accept'));
      return { bg: css.backgroundColor, fg: css.color, font: css.fontFamily, fontSize: css.fontSize, accept: accept.backgroundColor, buttonFont: accept.fontFamily };
    });
    assert.equal(style.bg, 'rgb(24, 37, 50)');
    assert.equal(style.fg, 'rgb(232, 213, 177)');
    assert.equal(style.accept, 'rgb(144, 114, 219)');
    assert.match(style.font, /Georgia/);
    assert.equal(style.buttonFont, style.font);
    assert.equal(style.fontSize, '15px');
    await page.screenshot({ path: `${dir}/custom-theme.png` });
    await page.locator('.confirm-dialog-cancel').click();
    await answer('custom', false);
    await page.evaluate(async () => {
      const { ipc } = await window.__qaImport('/src/ipc/index.ts');
      ipc.themesList = window.__confirmOriginalThemes;
      const settings = await window.__qaImport('/src/core/settings.ts');
      settings.setSetting('workbench.fontFamily', '');
      settings.setSetting('workbench.fontSize', 13);
      settings.setSetting('workbench.theme', 'glass-dark');
    });
  });
  await check('all four languages update the same controls, including the default title', async () => {
    const locales = [['zh-CN', '取消', '确认', '确认操作'], ['en', 'Cancel', 'Confirm', 'Confirm action'], ['zh-TW', '取消', '確認', '確認操作'], ['ja', 'キャンセル', '確認', '操作の確認']];
    await open('locales');
    await modal.waitFor();
    await modal.evaluate(el => { window.__confirmLocaleElement = el; });
    for (const [locale, cancel, accept, title] of locales) {
      await page.evaluate(async locale => (await window.__qaImport('/src/i18n/index.ts')).setLocale(locale), locale);
      assert.equal(await page.locator('.confirm-dialog-cancel').innerText(), cancel);
      assert.equal(await page.locator('.confirm-dialog-accept').innerText(), accept);
      assert.ok((await page.locator('.confirm-dialog-title').innerText()).endsWith(title));
      assert.equal(await modal.evaluate(el => el === window.__confirmLocaleElement), true);
      await focused('.confirm-dialog-cancel');
    }
    await page.keyboard.press('Escape');
    await answer('locales', false);
    await page.evaluate(async () => (await window.__qaImport('/src/i18n/index.ts')).setLocale('zh-CN'));
  });
  await check('message and explicit title remain plaintext and cannot inject HTML', async () => {
    const unsafe = '<img src=x onerror="window.__confirmInjected=true">';
    await open('plaintext', unsafe, { title: '<b>untrusted filename</b>' });
    await modal.waitFor();
    assert.equal(await page.locator('.confirm-dialog-message').innerText(), unsafe);
    assert.equal(await page.locator('.confirm-dialog-title').innerText(), '<b>untrusted filename</b>');
    assert.equal(await modal.locator('img, b').count(), 0);
    assert.equal(await page.evaluate(() => window.__confirmInjected), undefined);
    await page.locator('.confirm-dialog-cancel').click();
    await answer('plaintext', false);
  });
  await check('top-layer controls accept real clicks while body is inert and commands are frozen', async () => {
    await freeze(true);
    await open('inert-click');
    await modal.waitFor();
    assert.equal(await modal.evaluate(el => el.matches(':modal')), true);
    assert.equal(await page.evaluate(() => document.body.inert), true);
    await focused('.confirm-dialog-cancel');
    await page.locator('.confirm-dialog-accept').click();
    await answer('inert-click', true);
    assert.equal(await page.evaluate(() => document.body.inert), true);
    await freeze(false);
  });
  await check('default Enter, Space and Escape reject even while application keybindings are frozen', async () => {
    await freeze(true);
    for (const key of ['Enter', 'Space', 'Escape']) {
      await open(`reject-${key}`);
      await modal.waitFor();
      await focused('.confirm-dialog-cancel');
      await page.keyboard.press(key);
      await answer(`reject-${key}`, false);
    }
    await freeze(false);
  });
  await check('Tab and Shift+Tab stay in the modal; Enter only approves focused acceptance', async () => {
    await freeze(true);
    await open('tab');
    await modal.waitFor();
    await page.keyboard.press('Tab');
    await focused('.confirm-dialog-accept');
    await page.keyboard.press('Tab');
    await focused('.confirm-dialog-cancel');
    await page.keyboard.press('Shift+Tab');
    await focused('.confirm-dialog-accept');
    await page.keyboard.press('Enter');
    await answer('tab', true);
    await freeze(false);
  });
  await check('IME and repeated Enter never implicitly accept', async () => {
    await open('ime');
    await modal.waitFor();
    await page.locator('.confirm-dialog-accept').focus();
    await page.evaluate(() => {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
    });
    await unresolved('ime');
    await page.keyboard.press('Escape');
    await answer('ime', false);
  });
  await check('editor shortcuts and typing stay blocked while selected message text can be copied', async () => {
    await page.evaluate(async () => { window.__confirmDocBefore = (await window.__qaImport('/src/editor/tabs.ts')).getView().state.doc.toString(); });
    await open('keys', 'Select and copy this confirmation message');
    await modal.waitFor();
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.press('Control+w');
    // Space is deliberately a valid focused-button action, so type plain
    // letters here; Space cancellation is exercised separately above.
    await page.keyboard.type('unwanted');
    assert.equal(await page.locator('.palette').count(), 0);
    assert.equal(await page.evaluate(async () => (await window.__qaImport('/src/editor/tabs.ts')).getView().state.doc.toString()), await page.evaluate(() => window.__confirmDocBefore));
    await page.locator('.confirm-dialog-message').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), 'Select and copy this confirmation message');
    await unresolved('keys');
    await page.keyboard.press('Escape');
    await answer('keys', false);
  });
  await check('backdrop clicks do not choose an answer and closing restores originating focus', async () => {
    await page.locator('.tb-menu').focus();
    await open('backdrop');
    await modal.waitFor();
    await page.mouse.click(10, 10);
    await unresolved('backdrop');
    await focused('.confirm-dialog-cancel');
    await page.keyboard.press('Escape');
    await answer('backdrop', false);
    await page.waitForFunction(() => document.activeElement?.classList.contains('tb-menu'));
  });
  await check('abort immediately closes an active modal and skips cancelled queued requests', async () => {
    await freeze(true);
    await open('active', 'active request');
    await open('queued', 'cancelled queue entry');
    await open('last', 'final request');
    await abort('queued');
    await answer('queued', false);
    assert.equal(await page.locator('.confirm-dialog-message').innerText(), 'active request');
    await abort('active');
    await answer('active', false);
    await page.waitForFunction(() => document.querySelector('.confirm-dialog-message')?.textContent === 'final request');
    await abort('active');
    await unresolved('last');
    await page.locator('.confirm-dialog-cancel').click();
    await answer('last', false);
    await freeze(false);
    assert.equal(await modal.count(), 0);
    await page.locator('.cm-content').click();
    await page.keyboard.type('Editor usable after abort');
    assert.match(await page.locator('.cm-content').innerText(), /Editor usable after abort/);
  });
  await check('already-aborted requests never open and programmatic close resolves false', async () => {
    await open('aborted', 'expired', { aborted: true });
    await answer('aborted', false);
    assert.equal(await modal.count(), 0);
    await open('native-close');
    await modal.waitFor();
    await modal.evaluate(el => el.close());
    await answer('native-close', false);
    assert.equal(await modal.count(), 0);
  });
  await check('legacy fallback stays interactive beside inert body and preserves lifecycle ownership', async () => {
    await page.evaluate(() => {
      window.__confirmShowModal = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = undefined;
    });
    await open('fallback-ordinary', 'ordinary fallback confirmation');
    await modal.waitFor();
    assert.equal(await modal.evaluate(el => el.tagName), 'DIV');
    assert.equal(await page.locator('.confirm-dialog-overlay').evaluate(el => el.parentElement === document.documentElement), true);
    assert.equal(await page.evaluate(() => document.body.inert), false);
    // Quit begins after an ordinary confirmation has opened: only lifecycle owns inert.
    await freeze(true);
    await abort('fallback-ordinary');
    await answer('fallback-ordinary', false);
    assert.equal(await page.evaluate(() => document.body.inert), true);
    await freeze(false);
    assert.equal(await page.evaluate(() => document.body.inert), false);
    await freeze(true);
    await open('fallback-inert');
    await modal.waitFor();
    await page.locator('.confirm-dialog-accept').click();
    await answer('fallback-inert', true);
    assert.equal(await page.evaluate(() => document.body.inert), true);
    await freeze(false);
    await page.evaluate(() => { HTMLDialogElement.prototype.showModal = window.__confirmShowModal; });
  });
  await check('legacy fallback without native inert traps focus, rejects outside clicks and protects edits', async () => {
    await page.evaluate(() => {
      window.__confirmInertDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert');
      delete HTMLElement.prototype.inert;
      HTMLDialogElement.prototype.showModal = undefined;
    });
    await open('legacy', 'Legacy theme dialog');
    await modal.waitFor();
    await page.evaluate(() => document.querySelector('.cm-content').focus());
    await focused('.confirm-dialog-cancel');
    await page.mouse.click(10, 10);
    await unresolved('legacy');
    const prevented = await page.locator('.cm-content').evaluate(el => !el.dispatchEvent(new InputEvent('beforeinput', { data: 'unexpected', inputType: 'insertText', bubbles: true, cancelable: true })));
    assert.equal(prevented, true);
    await page.keyboard.press('Tab');
    await focused('.confirm-dialog-accept');
    await page.keyboard.press('Shift+Tab');
    await focused('.confirm-dialog-cancel');
    await page.screenshot({ path: `${dir}/legacy-fallback.png` });
    await page.keyboard.press('Escape');
    await answer('legacy', false);
    assert.equal(await page.locator('.confirm-dialog-overlay').count(), 0);
    await page.evaluate(() => {
      delete document.body.inert;
      Object.defineProperty(HTMLElement.prototype, 'inert', window.__confirmInertDescriptor);
      HTMLDialogElement.prototype.showModal = window.__confirmShowModal;
    });
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(systemDialogs, []);
  await writeFile(`${dir}/results.json`, JSON.stringify({ checks, errors, systemDialogs }, null, 2));
  console.log(`PASS ${checks.length} browser confirmation checks; no native/browser confirmation dialogs`);
} catch (error) {
  await page.screenshot({ path: `${dir}/failure.png` });
  await writeFile(`${dir}/results.json`, JSON.stringify({ checks, errors, systemDialogs, failure: String(error) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
