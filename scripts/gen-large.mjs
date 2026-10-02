/* global process, Buffer, console, performance */
// 生成大文件测试样本（不属于应用）：node scripts/gen-large.mjs [outDir]
// 产出 large-50mb.js / huge-150mb.js；可选 --bench 在 Node 中测量 50MB EditorState 构建耗时
import { createWriteStream, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MB = 1024 * 1024;
const outDir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : mkdtempSync(join(tmpdir(), 'boshu-large-'));

function block(i) {
  return `// block ${i}\nexport function fn${i}(a, b) {\n  const s = "str-${i}" + a;\n  if (b > ${i % 97}) { return s.repeat(2); }\n  return [a, b, ${i}].map((x) => x * 2).join(',');\n}\n\n`;
}

async function gen(name, bytes) {
  const file = join(outDir, name);
  const ws = createWriteStream(file);
  let written = 0, i = 0;
  while (written < bytes) {
    let buf = '';
    while (buf.length < MB) buf += block(i++);
    written += Buffer.byteLength(buf);
    if (!ws.write(buf)) await new Promise((r) => ws.once('drain', r));
  }
  await new Promise((r) => ws.end(r));
  console.log(`${file}  ${(written / MB).toFixed(1)} MB`);
  return file;
}

const f50 = await gen('large-50mb.js', 50 * MB);
await gen('huge-150mb.js', 150 * MB);

if (process.argv.includes('--bench')) {
  const { readFileSync } = await import('node:fs');
  const { EditorState, Text } = await import('@codemirror/state');
  const src = readFileSync(f50, 'utf8');
  let t = performance.now();
  const lines = src.split('\n');
  const doc = Text.of(lines);
  const tText = performance.now() - t;
  t = performance.now();
  const st = EditorState.create({ doc });
  const tState = performance.now() - t;
  console.log(`50MB: ${doc.lines} lines; split+Text.of ${tText.toFixed(0)} ms; EditorState.create ${tState.toFixed(0)} ms; heap ${(process.memoryUsage().heapUsed / MB).toFixed(0)} MB`);
  void st;
}
