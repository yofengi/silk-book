// 把源文本按顶层块切成段（只在围栏代码块 / $$ 公式块之外的空行处切），用于 Large/Huge 档分段渲染。
import type { Text } from '@codemirror/state';

export interface Segment {
  /** 起始行（0 基） */
  start: number;
  /** 行数 */
  lines: number;
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** minLines：一段至少累积多少行后，才在下一个安全空行处切断 */
export function splitSegments(doc: Text, minLines: number): Segment[] {
  const out: Segment[] = [];
  let buf: string[] = [];
  let start = 0;
  let line = 0;
  let fence: string | null = null;
  let inMath = false;
  const flush = () => {
    if (buf.length) out.push({ start, lines: buf.length, text: buf.join('\n') });
    start = line;
    buf = [];
  };
  for (const text of doc.iterLines()) {
    if (fence === null && !inMath && text.trim() === '' && buf.length >= minLines) {
      buf.push(text);
      line++;
      flush();
      continue;
    }
    buf.push(text);
    line++;
    const f = FENCE.exec(text);
    if (fence === null && !inMath) {
      if (f) fence = f[1][0].repeat(f[1].length);
      else if (/^ {0,3}\$\$/.test(text) && !/\$\$\s*$/.test(text.trim().slice(2))) inMath = true;
    } else if (fence !== null) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && text.trim() === f[1]) fence = null;
    } else if (/\$\$\s*$/.test(text)) {
      inMath = false;
    }
  }
  flush();
  return out;
}
