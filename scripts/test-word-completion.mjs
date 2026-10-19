import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const autocomplete = require('@codemirror/autocomplete');
const { EditorState } = require('@codemirror/state');
const imports = {
  '@codemirror/autocomplete': { ...autocomplete, autocompletion: config => config },
  '@replit/codemirror-minimap': {},
  '../themes': {},
  '../core/settings': {},
  '../i18n': {},
  './smart-copy': {},
  './spellcheck': {},
};
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => name in imports ? imports[name]
      : name.startsWith('.') ? load(resolve(dirname(file), `${name}.ts`)) : require(name),
  }, { filename: file });
  return module.exports;
}
const { completionExt } = load('src/editor/view.ts');
const { luaCompletion } = load('src/editor/completions/lua.ts');
function context(text, explicit = false) {
  const state = EditorState.create({ doc: text, selection: { anchor: text.length } });
  return new autocomplete.CompletionContext(state, text.length, explicit);
}
const wordSource = completionExt(true).override[0];
const labels = result => Array.from(result.options, option => option.label);

test('numeric input is suppressed for automatic and explicit document completion', async () => {
  for (const token of ['123', '-12', '+12', '1.25', '.25', '1.', '1e3', '1e-3', '1e+', '１２３', '١٢٣']) {
    for (const explicit of [false, true]) {
      assert.equal(await wordSource(context(`name2 var123 123 456\n${token}`, explicit)), null, token);
    }
  }
});

test('document completion excludes numeric candidates and preserves identifiers containing digits', async () => {
  const result = await wordSource(context('123 456 １２３ ١٢٣ 1e3 name2 var123 123abc\n', true));
  assert.deepEqual(labels(result).sort(), ['123abc', 'name2', 'var123']);
  for (const token of ['name2', 'var123', '123abc', '_123', '变量2']) {
    assert.ok(await wordSource(context(`name2 var123 123abc _123 变量2\n${token}`)), token);
  }
});

test('language completion follows the numeric rule even when document completion is disabled', async () => {
  const source = completionExt(false, luaCompletion).override[0];
  for (const token of ['123', '1.2', '1e-3', 'math.123']) {
    for (const explicit of [false, true]) assert.equal(await source(context(token, explicit)), null, token);
  }
  const member = await source(context('math.'));
  assert.ok(labels(member).includes('abs'));
  const top = await source(context('fun'));
  assert.ok(top.options.some(option => option.label === 'function' && typeof option.apply === 'function'));
  assert.deepEqual(Array.from(completionExt(false)), []);
});

test('cached results expire when their completion range becomes numeric', async () => {
  for (const [source, initial, next] of [
    [wordSource, 'name2\n', 'name2\n12'],
    [completionExt(false, luaCompletion).override[0], 'math.', 'math.12'],
  ]) {
    const result = await source(context(initial, true));
    const changed = context(next);
    assert.equal(typeof result.validFor, 'function');
    assert.equal(result.validFor(next.slice(result.from), result.from, next.length, changed.state), false);
    assert.equal(await source(changed), null);
  }
});

test('cached results remain valid for identifiers with digits', async () => {
  const result = await wordSource(context('name2 var123\nna'));
  const changed = context('name2 var123\nname2');
  assert.equal(result.validFor('name2', result.from, changed.pos, changed.state), true);
  assert.equal(result.validFor('name2.', result.from, changed.pos, changed.state), false);
});

test('asynchronous language sources exclude numeric candidates', async () => {
  const source = completionExt(false, async ctx => ({
    from: ctx.pos, options: [{ label: '123' }, { label: 'name2' }], validFor: /\w*/,
  })).override[0];
  assert.deepEqual(labels(await source(context('', true))), ['name2']);
  assert.equal(await source(context('12', true)), null);
});

test('source validity callbacks and incremental updates keep the numeric gate', async () => {
  const source = completionExt(false, ctx => ({
    from: ctx.pos, options: [{ label: 'name2' }],
    validFor: text => text.startsWith('n'),
    update: (_current, from) => ({ from, options: [{ label: '456' }, { label: 'var123' }] }),
  })).override[0];
  const result = await source(context('', true));
  const name = context('name2');
  assert.equal(result.validFor('name2', 0, name.pos, name.state), true);
  const variable = context('var123');
  assert.equal(result.validFor('var123', 0, variable.pos, variable.state), false);
  assert.deepEqual(labels(result.update(result, 0, variable.pos, variable)), ['var123']);
  const number = context('12');
  assert.equal(result.validFor('12', 0, number.pos, number.state), false);
  assert.equal(result.update(result, 0, number.pos, number), null);
});
