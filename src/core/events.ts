// 类型化事件总线
export interface EventMap {
  'tab.activated': { id: string | null };
  'tab.changed': { id: string };
  /** 文档内容变更（每个事务一次，订阅方自行防抖） */
  'doc.changed': { id: string };
  'tabs.listChanged': undefined;
  'settings.changed': { key: string };
  /** 更新检查状态、已验证 Release 或忽略版本变化。 */
  'updates.changed': undefined;
  'recent.changed': undefined;
  'theme.changed': { kind: 'light' | 'dark' };
  'keybindings.changed': undefined;
  /** 关闭确认期间阻止新的用户命令；浮层和按钮需同步恢复。 */
  'commands.executionChanged': { blocked: boolean };
  /** 字体 CSS 变量已更新；编辑器需重新测量 */
  'fonts.changed': undefined;
  /** 界面语言已切换（语言包已加载）；UI 需重新渲染文案 */
  'locale.changed': { locale: string };
  /** 拼写检查后端不可用（本会话已停用） */
  'spellcheck.unsupported': undefined;
}

type Handler<T> = (payload: T) => void;

export class EventBus<M extends object> {
  private handlers = new Map<keyof M, Set<Handler<never>>>();

  on<K extends keyof M>(type: K, fn: Handler<M[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const s = set;
    s.add(fn as Handler<never>);
    return () => void s.delete(fn as Handler<never>);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    this.handlers.get(type)?.forEach((fn) => (fn as Handler<M[K]>)(payload));
  }
}

export const events = new EventBus<EventMap>();
