/**
 * 会话路由（纯逻辑，无宿主依赖——逐线矩阵之外单测全覆盖）。
 *
 * 两层分离：
 * - 入站自动路由：channel+kind+chatId(+thread) → 稳定会话 id（`imu:` 前缀，
 *   每聊天一条独立会话，dsh-im-connect 的频道模型）；
 * - 主动投递目标：botId+targetId 显式创建的稳定投递地址，独立于会话绑定
 *   （目标库在 P1 的 delivery 模块落地，这里只定 key 形态）。
 */

export type ChatKind = 'dm' | 'group'

export interface ChatAddress {
  channel: string
  kind: ChatKind
  chatId: string
  threadId?: string
}

/** 会话 id：imu:<channel>:<kind>:<chatId>[:<thread>]；段内禁 ':'（防分隔符歧义），非法字符归一下划线。 */
export function makeSessionId(address: ChatAddress): string {
  const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9_.-]+/g, '_')
  const base = `imu:${sanitize(address.channel)}:${address.kind}:${sanitize(address.chatId)}`
  return address.threadId === undefined || address.threadId === '' ? base : `${base}:${sanitize(address.threadId)}`
}

export function chatKey(address: ChatAddress): string {
  return makeSessionId(address)
}

/** 群聊触发规则（红线 D6）：群只认显式 @ 本机器人；私聊走白名单。 */
export function shouldRespondToGroup(mentionedBot: boolean): boolean {
  return mentionedBot
}

export interface Binding {
  sessionId: string
  /** 绑定时是否来自 /session 显式指定（显式绑定不随 /new 自动重建）。 */
  explicit: boolean
}

export class ChatRouter {
  private bindings = new Map<string, Binding>()

  /** 入站消息 → 会话 id；无绑定时按地址生成并登记隐式绑定。 */
  resolve(address: ChatAddress): Binding {
    const key = chatKey(address)
    const hit = this.bindings.get(key)
    if (hit !== undefined) return hit
    const binding: Binding = { sessionId: makeSessionId(address), explicit: false }
    this.bindings.set(key, binding)
    return binding
  }

  /** /session <id> 显式绑定既有会话。 */
  bind(address: ChatAddress, sessionId: string): void {
    this.bindings.set(chatKey(address), { sessionId, explicit: true })
  }

  /** /new：解除绑定，下一条消息重开新会话。 */
  unbind(address: ChatAddress): void {
    this.bindings.delete(chatKey(address))
  }

  /** 本聊天（含 thread 变体）登记过的全部会话（/unbind 列表）。 */
  list(address: ChatAddress): Binding[] {
    const prefix = `imu:${address.channel.replace(/[^A-Za-z0-9_.-]+/g, '_')}:${address.kind}:${address.chatId.replace(/[^A-Za-z0-9_.-]+/g, '_')}`
    const seen = new Map<string, Binding>()
    for (const [key, binding] of this.bindings) {
      if (key === prefix || key.startsWith(prefix + ':')) seen.set(binding.sessionId, binding)
    }
    return [...seen.values()]
  }

  size(): number {
    return this.bindings.size
  }
}
