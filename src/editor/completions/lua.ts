// Lua 补全源：关键字、全局函数、标准库成员（table. / string. / math. …）、常用代码片段。
// 独立懒加载 chunk，只在 Lua 文档中通过 languages.ts 的 completions 挂载。
import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';

const KEYWORDS = [
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
];

const GLOBAL_FUNCTIONS = [
  'print', 'pairs', 'ipairs', 'tostring', 'tonumber', 'type', 'require', 'setmetatable', 'getmetatable',
  'select', 'error', 'assert', 'pcall', 'xpcall', 'next', 'rawget', 'rawset', 'rawequal', 'rawlen',
  'unpack', 'load', 'loadfile', 'dofile', 'collectgarbage',
];
const GLOBAL_VARIABLES = ['_G', '_VERSION'];

/** 标准库成员；以 = 开头的是常量/字段，其余为函数 */
const LIBS: Record<string, string[]> = {
  table: ['concat', 'insert', 'move', 'pack', 'remove', 'sort', 'unpack'],
  string: ['byte', 'char', 'dump', 'find', 'format', 'gmatch', 'gsub', 'len', 'lower', 'match', 'pack', 'packsize', 'rep', 'reverse', 'sub', 'unpack', 'upper'],
  math: [
    'abs', 'acos', 'asin', 'atan', 'ceil', 'cos', 'deg', 'exp', 'floor', 'fmod', 'log', 'max', 'min', 'modf',
    'rad', 'random', 'randomseed', 'sin', 'sqrt', 'tan', 'tointeger', 'type', 'ult', '=huge', '=pi', '=maxinteger', '=mininteger',
  ],
  os: ['clock', 'date', 'difftime', 'execute', 'exit', 'getenv', 'remove', 'rename', 'setlocale', 'time', 'tmpname'],
  io: ['close', 'flush', 'input', 'lines', 'open', 'output', 'popen', 'read', 'tmpfile', 'type', 'write', '=stdin', '=stdout', '=stderr'],
  coroutine: ['close', 'create', 'isyieldable', 'resume', 'running', 'status', 'wrap', 'yield'],
};

const SNIPPETS: Completion[] = [
  snippetCompletion('function ${name}(${params})\n\t${}\nend', { label: 'function', detail: '… end', type: 'keyword', boost: 1 }),
  snippetCompletion('local function ${name}(${params})\n\t${}\nend', { label: 'local function', detail: '… end', type: 'keyword', boost: 1 }),
  snippetCompletion('if ${cond} then\n\t${}\nend', { label: 'if', detail: '… then … end', type: 'keyword', boost: 1 }),
  snippetCompletion('for ${i} = ${first}, ${last} do\n\t${}\nend', { label: 'for', detail: 'i = a, b do … end', type: 'keyword', boost: 1 }),
  snippetCompletion('for ${k}, ${v} in pairs(${t}) do\n\t${}\nend', { label: 'for', detail: 'k, v in pairs(t)', type: 'keyword', boost: 1 }),
  snippetCompletion('for ${i}, ${v} in ipairs(${t}) do\n\t${}\nend', { label: 'for', detail: 'i, v in ipairs(t)', type: 'keyword', boost: 1 }),
  snippetCompletion('while ${cond} do\n\t${}\nend', { label: 'while', detail: '… do … end', type: 'keyword', boost: 1 }),
  snippetCompletion('repeat\n\t${}\nuntil ${cond}', { label: 'repeat', detail: '… until', type: 'keyword', boost: 1 }),
];

const TOP_LEVEL: Completion[] = [
  ...KEYWORDS.map((label): Completion => ({ label, type: 'keyword' })),
  ...GLOBAL_FUNCTIONS.map((label): Completion => ({ label, type: 'function' })),
  ...GLOBAL_VARIABLES.map((label): Completion => ({ label, type: 'variable' })),
  ...Object.keys(LIBS).map((label): Completion => ({ label, type: 'namespace' })),
  ...SNIPPETS,
];

const MEMBERS = new Map<string, Completion[]>(
  Object.entries(LIBS).map(([lib, names]) => [
    lib,
    names.map((n): Completion => (n.startsWith('=')
      ? { label: n.slice(1), type: 'constant', detail: lib }
      : { label: n, type: 'function', detail: lib })),
  ]),
);

const IDENT = /^[\w]*$/;

function inStringOrComment(ctx: CompletionContext): boolean {
  const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
  return /string|comment/i.test(node.name);
}

export const luaCompletion: CompletionSource = (ctx: CompletionContext): CompletionResult | null => {
  if (inStringOrComment(ctx)) return null;
  // lib.member：只对已知标准库表补全；其它 a.b / a:b（含 x.table.）交给单词补全
  const member = ctx.matchBefore(/[A-Za-z_]\w*[.:]\w*$/);
  if (member) {
    const sep = member.text.search(/[.:]/);
    const lib = member.text.slice(0, sep);
    const before = member.from > 0 ? ctx.state.sliceDoc(member.from - 1, member.from) : '';
    const list = member.text[sep] === '.' && before !== '.' && before !== ':' ? MEMBERS.get(lib) : undefined;
    if (!list) return null;
    return { from: member.from + sep + 1, options: list, validFor: IDENT };
  }
  const word = ctx.matchBefore(/[A-Za-z_]\w*$/);
  if (!word && !ctx.explicit) return null;
  return { from: word ? word.from : ctx.pos, options: TOP_LEVEL, validFor: IDENT };
};
