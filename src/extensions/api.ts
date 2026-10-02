// 扩展 API（v1 只定义接口，无加载器、无实现）。见 ARCHITECTURE.md 4.8。
// 扩展通过受限的 ExtensionContext 访问命令注册表、事件与配置，不能直接接触 EditorView 或 ipc。
import type { LanguageSupport } from '@codemirror/language';
import type { Command } from '../core/commands';
import type { EventMap } from '../core/events';
import type { SettingKey, SettingValue } from '../core/settings';
import type { ThemeKind } from '../themes';

/** 取消注册 / 取消订阅 */
export interface Disposable {
  dispose(): void;
}

/** 命令注册表的受限视图 */
export interface ExtensionCommands {
  register(cmd: Command): Disposable;
  execute(id: string, args?: unknown): Promise<unknown>;
  list(): readonly Pick<Command, 'id' | 'title'>[];
}

/** 事件总线的只订阅视图（扩展不能伪造核心事件） */
export interface ExtensionEvents {
  on<K extends keyof EventMap>(type: K, fn: (payload: EventMap[K]) => void): Disposable;
}

/** 配置的受限视图：核心配置只读；扩展自有配置在 `<extensionId>.*` 命名空间下读写 */
export interface ExtensionSettings {
  get<K extends SettingKey>(key: K): SettingValue<K>;
  getOwn(key: string): unknown;
  setOwn(key: string, value: unknown): void;
}

export interface ExtensionContext {
  readonly extensionId: string;
  readonly commands: ExtensionCommands;
  readonly events: ExtensionEvents;
  readonly settings: ExtensionSettings;
  /** 停用时统一释放 */
  readonly subscriptions: Disposable[];
}

/** 语言贡献：与 editor/languages.ts 的内置语言表同构，按需加载 */
export interface LanguageContribution {
  id: string;
  name: string;
  extensions: readonly string[];
  load(): Promise<LanguageSupport>;
}

/** 主题贡献：一组 CSS 变量（与 themes/light.css 同名的 --* / --tok-* 变量） */
export interface ThemeContribution {
  id: string;
  label: string;
  kind: ThemeKind;
  variables: Readonly<Record<`--${string}`, string>>;
}

/** 预览渲染器贡献：处理某种围栏代码块语言（如 'plantuml'） */
export interface PreviewRendererContribution {
  id: string;
  /** 匹配的代码块语言标识 */
  languages: readonly string[];
  /** 返回的 HTML 会经过 DOMPurify 清洗后插入 */
  render(source: string, opts: { theme: ThemeKind }): string | Promise<string>;
}

export interface ExtensionContributions {
  commands?: readonly Command[];
  languages?: readonly LanguageContribution[];
  themes?: readonly ThemeContribution[];
  previewRenderers?: readonly PreviewRendererContribution[];
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  /** 兼容的帛书 API 版本 */
  apiVersion: 1;
}

/** 扩展模块的导出形状 */
export interface ExtensionModule {
  readonly manifest: ExtensionManifest;
  readonly contributes?: ExtensionContributions;
  activate(ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
