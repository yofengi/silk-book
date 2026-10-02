// 命令注册表：菜单、快捷键、命令面板只引用命令 id
import { events } from './events';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CommandContext {}

export interface Command {
  id: string;
  /** 标题：内置命令用函数（如 () => t('cmd.file.save')），每次读取时按当前语言解析；扩展可传固定字符串 */
  title: string | (() => string);
  run(ctx: CommandContext, args?: unknown): unknown | Promise<unknown>;
  when?(ctx: CommandContext): boolean;
}

/** 解析命令标题（当前语言）；未注册的 id 原样返回 */
export function commandTitle(cmdOrId: Command | string | undefined): string {
  const cmd = typeof cmdOrId === 'string' ? registry.get(cmdOrId) : cmdOrId;
  if (!cmd) return typeof cmdOrId === 'string' ? cmdOrId : '';
  return typeof cmd.title === 'function' ? cmd.title() : cmd.title;
}

const registry = new Map<string, Command>();
const ctx: CommandContext = {};
let executionBlocked = false;

export function isCommandExecutionBlocked(): boolean { return executionBlocked; }

/** 关闭/退出确认使用同一门闩，所有命令入口都必须检查。IPC 原生确认不经过命令入口。 */
export function setCommandExecutionBlocked(blocked: boolean): void {
  if (executionBlocked === blocked) return;
  executionBlocked = blocked;
  events.emit('commands.executionChanged', { blocked });
}

export function registerCommand(cmd: Command): () => void {
  if (registry.has(cmd.id)) throw new Error(`Command already registered: ${cmd.id}`);
  registry.set(cmd.id, cmd);
  return () => registry.delete(cmd.id);
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

export function listCommands(): Command[] {
  return [...registry.values()];
}

export function isEnabled(id: string): boolean {
  const cmd = registry.get(id);
  return !executionBlocked && !!cmd && (cmd.when ? cmd.when(ctx) : true);
}

export async function executeCommand(id: string, args?: unknown): Promise<unknown> {
  if (executionBlocked) return undefined;
  const cmd = registry.get(id);
  if (!cmd) throw new Error(`Unknown command: ${id}`);
  if (cmd.when && !cmd.when(ctx)) return undefined;
  try {
    return await cmd.run(ctx, args);
  } catch (e) {
    console.error(`[command ${id}]`, e);
    throw e;
  }
}
