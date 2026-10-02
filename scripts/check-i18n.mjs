/* global console */
// Run with node scripts/check-i18n.mjs. Executes the actual TypeScript modules,
// with only platform APIs mocked; no build output or application files are changed.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { EditorState } from '@codemirror/state';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const locales = ['zh-CN', 'en', 'zh-TW', 'ja'];

function harness({ language = 'system', systemLocale = async () => 'zh-CN', navigatorLanguage = 'en-US' } = {}) {
  const cache = new Map();
  const settings = { language };
  const document = { documentElement: { lang: '' }, title: '' };
  const warnings = [];
  function load(file) {
    const path = resolve(root, file);
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      fileName: path,
    }).outputText;
    const require = (id) => {
      const target = resolve(dirname(path), id);
      if (target === join(root, 'src/core/settings')) return { getSetting: () => settings.language };
      if (target === join(root, 'src/ipc')) return { ipc: { systemLocale } };
      return load(`${target}.ts`);
    };
    runInNewContext(code, { exports: module.exports, module, require, document, navigator: { language: navigatorLanguage }, console: { ...console, warn: (...args) => warnings.push(args) }, Intl }, { filename: path });
    return module.exports;
  }
  const api = load('src/i18n/index.ts');
  const boot = load('src/i18n/boot.ts');
  const { events } = load('src/core/events.ts');
  return { api, boot, events, document, settings, load, warnings };
}

function flatten(value, prefix = '', result = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') result.set(`${prefix}${key}`, child);
    else flatten(child, `${prefix}${key}.`, result);
  }
  return result;
}

function placeholders(message) {
  return [...new Set([...message.matchAll(/\{(\w+)(?:\}|,\s*plural,)/g)].map((m) => m[1]))].sort();
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const h = harness();
const dictionaries = new Map(locales.map((locale) => {
  const mod = h.load(`src/i18n/locales/${locale}.ts`);
  return [locale, flatten(locale === 'zh-CN' ? mod.zhCN : mod.default)];
}));
const base = dictionaries.get('zh-CN');
for (const [locale, dictionary] of dictionaries) {
  assert.deepEqual([...dictionary.keys()].sort(), [...base.keys()].sort(), `${locale}: missing or extra keys`);
  for (const [key, value] of dictionary) {
    assert.ok(value.length, `${locale}:${key} is empty`);
    assert.deepEqual(placeholders(value), placeholders(base.get(key)), `${locale}:${key} placeholders differ`);
    assert.equal((value.match(/\$/g) ?? []).length, (base.get(key).match(/\$/g) ?? []).length, `${locale}:${key} CodeMirror placeholders differ`);
    if (value.includes(', plural,')) assert.match(value, /other\s*\{/, `${locale}:${key} has no other plural branch`);
  }
  await h.api.setLocale(locale);
  assert.equal(h.document.documentElement.lang, locale);
  for (const [key, value] of dictionary) {
    for (const count of [0, 1, 2]) {
      const params = Object.fromEntries(placeholders(value).map((name) => [name, name === 'count' ? count : `sample-${name}`]));
      assert.doesNotMatch(h.api.t(key, params), /\{\w+(?:\}|,\s*plural,)/, `${locale}:${key} did not format for ${count}`);
    }
  }
  const phrases = h.api.editorPhrases();
  const state = EditorState.create({ extensions: EditorState.phrases.of(phrases) });
  assert.equal(state.phrase('Find'), h.api.t('editor.phrases.find'));
  assert.equal(state.phrase('replaced $ matches', 3), h.api.t('editor.phrases.replacedMatches').replace('$', '3'));
  // Read the installed dependency source to catch newly introduced UI phrases.
  for (const packageName of ['search', 'view', 'language', 'autocomplete', 'commands']) {
    const source = readFileSync(join(root, `node_modules/@codemirror/${packageName}/dist/index.js`), 'utf8');
    const used = [...source.matchAll(/\bphrase\((?:view,\s*)?"([^"\n]+)"/g)].map((m) => m[1]);
    for (const phrase of used) assert.ok(Object.hasOwn(phrases, phrase), `${locale}: untranslated CodeMirror phrase ${phrase}`);
  }
  console.log(`${locale}: ${dictionary.size} keys, placeholders and formatting OK`);
}

for (const [tag, expected] of [
  ['zh-CN', 'zh-CN'], ['zh_SG', 'zh-CN'], ['zh-Hans-TW', 'zh-CN'],
  ['zh-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'], ['zh-Hant-HK', 'zh-TW'],
  ['ja-JP', 'ja'], ['EN_us', 'en'], ['fr-FR', 'en'], ['', 'en'],
]) assert.equal(h.api.resolveLocale(tag), expected, tag);

const hardcoded = [];
for (const path of files(join(root, 'src'))) {
  if (path.includes(`${join('src', 'i18n')}`)) continue;
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isStringLiteralLike(node) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(node.text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      hardcoded.push(`${path}:${line + 1} ${node.text.slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.deepEqual(hardcoded, [], `UI literals outside locale files:\n${hardcoded.join('\n')}`);

await h.api.setLocale('en');
assert.equal(h.api.productName(), 'silk book');
assert.equal(h.document.title, 'silk book');
assert.equal(h.api.t('settings.fonts.codePreviewComment'), 'Hello, silk book');
assert.equal(h.api.t('settings.assoc.unregistered', { count: 1 }), 'Unregistered 1 extension.');
assert.equal(h.api.t('settings.assoc.unregistered', { count: 2 }), 'Unregistered 2 extensions.');
await Promise.all([h.api.setLocale('ja'), h.api.setLocale('en'), h.api.setLocale('zh-TW')]);
assert.equal(h.api.getLocale(), 'zh-TW', 'latest locale request must win');

const fallback = harness({ systemLocale: async () => { throw new Error('unavailable'); }, navigatorLanguage: 'ja-JP' });
assert.equal(await fallback.boot.resolveLanguage('system'), 'ja');
assert.equal(fallback.warnings.length, 1, 'system locale failure uses navigator fallback');
const deferred = harness();
let releaseSystem;
const race = harness({ language: 'en', systemLocale: () => new Promise((resolve) => { releaseSystem = resolve; }) });
await race.boot.initLanguage();
race.settings.language = 'system';
race.events.emit('settings.changed', { key: 'workbench.language' });
race.settings.language = 'ja';
race.events.emit('settings.changed', { key: 'workbench.language' });
releaseSystem('zh-TW');
for (let i = 0; i < 10; i++) await Promise.resolve();
assert.equal(race.api.getLocale(), 'ja', 'slow system resolution must not overwrite a newer explicit language');
let releaseStartup;
const startupRace = harness({ systemLocale: () => new Promise((resolve) => { releaseStartup = resolve; }) });
const initializing = startupRace.boot.initLanguage();
startupRace.settings.language = 'en';
startupRace.events.emit('settings.changed', { key: 'workbench.language' });
releaseStartup('ja-JP');
await initializing;
for (let i = 0; i < 10; i++) await Promise.resolve();
assert.equal(startupRace.api.getLocale(), 'en', 'settings changes during initialization must be observed');
assert.equal(await deferred.boot.resolveLanguage('system'), 'zh-CN');
console.log('Locale mapping, system fallback, switching races, branding and UI literals OK');
