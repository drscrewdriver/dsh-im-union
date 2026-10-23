/**
 * 会话路由（纯逻辑，无宿主依赖——逐线矩阵之外单测全覆盖）。
 *
 * 两层分离：
 * - 入站自动路由：channel+kind+chatId(+thread) → 稳定会话 id（`im:union:` 前缀，
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

/**
 * 会话 id：im:union:<channel>:<kind>:<chatId>[:<thread>]；段内禁 ':'（防分隔符歧义），
 * 非法字符归一下划线。前缀用宿主 IM 约定 `im:`——desktop 侧栏据此把会话分进
 * 「频道」页（dsh-im-connect 源码锚点：「IM 与任务的区分靠 sessionId 的 im: 前缀」，
 * 旧 imu: 前缀会永远落在「任务/未分组」）；`union` 段避免与其它 IM 插件撞名。
 */
export function makeSessionId(address: ChatAddress): string {
  const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9_.-]+/g, '_')
  const base = `im:union:${sanitize(address.channel)}:${address.kind}:${sanitize(address.chatId)}`
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

/** /new 轮换下来的旧绑定：不销毁，/sessions 标注、/session 可再接续。 */
export interface HistoricalBinding {
  sessionId: string
  detachedAt: number
}

/** 轮换纪元戳的单调位（模块级：跨 ChatRouter 实例也不回拨，同毫秒自增防撞）。 */
let lastRotationStamp = 0

export class ChatRouter {
  private bindings = new Map<string, Binding>()
  private readonly historical = new Map<string, HistoricalBinding>()

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

  /**
   * /new 轮换目标 id：确定性 base 追加 13 位毫秒纪元。base 无纪元会让「解绑后下一条
   * 消息重建」得到同一个 id（desktop 实证：/new 等于没换）；纪元段缀在 chatId 之后，
   * 前缀匹配（list）与频道分组（im: 前缀）不受影响。同毫秒连发（测试/连打 /new）
   * 单调自增防撞（dsh-im-connect session-id 同款纪律）。
   */
  makeRotatedSessionId(address: ChatAddress): string {
    let stamp = Date.now()
    if (stamp <= lastRotationStamp) stamp = lastRotationStamp + 1
    lastRotationStamp = stamp
    return `${makeSessionId(address)}:${stamp}`
  }

  /**
   * /new 轮换落位：绑定换到 newSessionId，oldSessionId 转入历史（不销毁）。
   * old 由调用方在创建前捕获——ensure 的 bind 会先写新绑定，此处再读就读到新的了
   * （dsh-im-connect rotate 同款纪律：新会话创建成功才换绑，失败时旧句柄仍可用）。
   */
  rotate(address: ChatAddress, newSessionId: string, oldSessionId?: string): void {
    const key = chatKey(address)
    if (oldSessionId !== undefined && oldSessionId !== newSessionId) {
      this.historical.set(oldSessionId, { sessionId: oldSessionId, detachedAt: Date.now() })
    }
    this.bindings.set(key, { sessionId: newSessionId, explicit: false })
  }

  /** 会话 id 是否已被轮下（/sessions 标注「已解绑」）。 */
  isHistorical(sessionId: string): boolean {
    return this.historical.has(sessionId)
  }

  /** 当前绑定中的全部会话 id（admin /channels 运行态合并用）。 */
  boundSessionIds(): string[] {
    return [...new Set([...this.bindings.values()].map((b) => b.sessionId))]
  }

  /** /new：解除绑定，下一条消息重开新会话。 */
  unbind(address: ChatAddress): void {
    this.bindings.delete(chatKey(address))
  }

  /** 本聊天（含 thread 变体）登记过的全部会话（/unbind 列表）。 */
  list(address: ChatAddress): Binding[] {
    const prefix = `im:union:${address.channel.replace(/[^A-Za-z0-9_.-]+/g, '_')}:${address.kind}:${address.chatId.replace(/[^A-Za-z0-9_.-]+/g, '_')}`
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
