/* global console, process, window, performance, URL, document, getComputedStyle */
// Inspect real status menus with content beneath both sides of the editor.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright');
const output = 'artifacts/qa-status-material';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 720 }, locale: 'zh-CN' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
async function setting(key, value) {
  await page.evaluate(async ({ key, value }) => (await window.__qaImport('/src/core/settings.ts')).setSetting(key, value), { key, value });
}
async function command(id) {
  await page.evaluate(async id => (await window.__qaImport('/src/core/commands.ts')).executeCommand(id), id);
}
async function closeMenus() {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}
async function material() {
  return page.locator('.sb-menu').evaluateAll(menus => menus.map(menu => {
    const css = getComputedStyle(menu);
    const box = menu.getBoundingClientRect();
    return {
      parent: menu.parentElement.tagName, color: css.backgroundColor,
      image: css.backgroundImage, blur: css.backdropFilter,
      border: css.border, shadow: css.boxShadow, radius: css.borderRadius,
      x: box.x, y: box.y, width: box.width, height: box.height,
      right: box.right, bottom: box.bottom,
    };
  }));
}
try {
  await page.goto(process.env.QA_URL || 'http://127.0.0.1:1420');
  await page.waitForSelector('[role=toolbar]');
  await page.evaluate(() => {
    window.__qaImport = path => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path)?.name ?? path);
  });
  await setting('workbench.language', 'zh-CN');
  await command('file.new');
  await page.locator('.cm-content').fill(Array.from({ length: 70 }, (_, i) => `${i + 1} ${'毛玻璃 Material comparison 0123456789 '.repeat(9)}`).join('\n'));
  await page.locator('.cm-scroller').evaluate(element => { element.scrollTop = element.scrollHeight; element.scrollLeft = 0; });
  for (const theme of ['glass-dark', 'glass-light', 'dark', 'light']) {
    await setting('workbench.theme', theme);
    const surfaces = {};
    for (const [name, button] of [['path', '.sb-path'], ['encoding', '.sb-enc'], ['eol', '.sb-eol']]) {
      await closeMenus();
      await page.locator(button).click();
      await page.waitForSelector('.sb-menu');
      surfaces[name] = (await material())[0];
      await page.screenshot({ path: `${output}/${theme}-${name}.png` });
    }
    await closeMenus();
    await page.locator('.sb-enc').click();
    await page.getByRole('menuitem', { name: '通过编码保存', exact: true }).hover();
    await page.waitForSelector('.sb-menu.menu-sub');
    surfaces.submenu = (await material())[1];
    await page.screenshot({ path: `${output}/${theme}-submenu.png` });
    const styleKeys = ['parent', 'color', 'image', 'blur', 'border', 'shadow', 'radius'];
    for (const [name, surface] of Object.entries(surfaces)) {
      for (const key of styleKeys) assert.equal(surface[key], surfaces.path[key], `${theme}/${name}/${key}`);
      assert.ok(surface.x >= 4 && surface.y >= 4 && surface.right <= 1096 && surface.bottom <= 716, `${theme}/${name} outside viewport`);
    }
    const minimap = await page.locator('.cm-minimap-gutter').boundingBox();
    if (minimap) {
      assert.ok(surfaces.encoding.right <= minimap.x - 4, `${theme}/encoding covers minimap`);
      assert.ok(surfaces.eol.right <= minimap.x - 4, `${theme}/eol covers minimap`);
    }
    assert.ok(surfaces.submenu.right + 2 <= surfaces.encoding.x || surfaces.submenu.x >= surfaces.encoding.right + 2, `${theme}/submenu overlaps its parent material`);
    console.log(`PASS ${theme} shared material, editor placement and separate submenu`);
    await closeMenus();
  }
  await command('view.toggleMinimap');
  await setting('workbench.theme', 'glass-dark');
  await page.locator('.sb-enc').click();
  const owner = await page.locator('.sb-enc').boundingBox();
  assert.ok(Math.abs((await material())[0].right - (owner.x + owner.width)) <= 1, 'menu without minimap is not aligned to its button');
  await closeMenus();
  console.log('PASS menu stays anchored when minimap is disabled');
  await command('view.toggleMinimap');
  await page.setViewportSize({ width: 640, height: 400 });
  await page.locator('.sb-enc').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.sb-menu.menu-sub');
  for (const surface of await material()) {
    assert.ok(surface.x >= 4 && surface.y >= 4 && surface.right <= 636 && surface.bottom <= 396, 'compact menu outside viewport');
  }
  await page.screenshot({ path: `${output}/glass-dark-compact-submenu.png` });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sb-menu.menu-sub').count(), 0);
  assert.equal(await page.locator('.sb-menu').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sb-menu').count(), 0);
  assert.equal(await page.locator('.sb-enc').evaluate(element => document.activeElement === element), true);
  console.log('PASS compact viewport and keyboard navigation');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
