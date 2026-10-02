// Exercise the real TypeScript modules with only their desktop IPC boundary replaced.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import console from 'node:console';
import { TextEncoder, TextDecoder } from 'node:util';
import { setTimeout, clearTimeout } from 'node:timers';
import vm from 'node:vm';
import ts from 'typescript';

export async function loadModule(file, mocks = {}, globals = {}) {
  const context = vm.createContext({ console, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask: globalThis.queueMicrotask, ...globals });
  const modules = new Map();
  async function synthetic(id, exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context, identifier: id });
    await module.link(() => {});
    return module;
  }
  async function source(path) {
    if (modules.has(path)) return modules.get(path);
    const content = await readFile(path, 'utf8');
    const js = ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const module = new vm.SourceTextModule(js, { context, identifier: path });
    modules.set(path, module);
    await module.link(async (specifier, parent) => {
      if (specifier in mocks) return synthetic(specifier, mocks[specifier]);
      if (!specifier.startsWith('.')) return synthetic(specifier, await import(specifier));
      return source(resolve(dirname(parent.identifier), `${specifier}.ts`));
    });
    return module;
  }
  const module = await source(resolve(file));
  await module.evaluate();
  return module.namespace;
}

export function fakeTimers() {
  const jobs = new Map();
  let seq = 0;
  return {
    setTimeout(fn) { jobs.set(++seq, fn); return seq; },
    clearTimeout(id) { jobs.delete(id); },
    async run() { const current = [...jobs.values()]; jobs.clear(); for (const fn of current) await fn(); },
  };
}
