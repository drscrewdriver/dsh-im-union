/**
 * IM 引擎网关：入站消息 → 准入 → 命令/会话 → 投递。
 *
 * 姿态：
 * - 默认拒绝（红线 D5/D6）：私聊白名单为空即拒（扫码自动入表在 M1 渠道层做）；
 *   群聊仅显式 @ 触发；
 * - 每聊天串行队列：当前任务未完不并发下一条（排队语义，插话 /steer P1）；
 * - 投递走 adapter.reply/Receipt：uncertain 不重发（D7）；
 * - 事件词汇表（宿主 @0.2.x 锚点 packages/core/session/src/types.ts）：
 *   `assistant/message` 每 step 落定一次（非 token 级增量，投递粒度由宿主
 *   事件协议决定），`turn/end{reason}` 收轮；订阅先于 prompt（防首事件丢失）。
 */
import type { CordisLike, LoggerLike } from '../types.js'
import type { UnionCapabilities } from '../host-compat/services.js'
import type { SessionApi } from '../host-compat/session-api.js'
import { UnsupportedError } from '../host-compat/session-api.js'
import { ChatRouter, shouldRespondToGroup, type ChatAddress } from './router.js'
import type { ChannelAdapter, Receipt, ReplyStream, SemanticMessage } from '../channels/types.js'

export interface AccountPolicy {
  /** 私聊白名单 userId 集合；空集合=拒绝所有私聊（扫码自动入表由渠道层维护）。 */
  dmAllowlist: Set<string>
  /** 群聊总开关（默认开，触发仍需 @）。 */
  groupEnabled: boolean
}

export interface EngineDeps {
  ctx: CordisLike
  caps: UnionCapabilities
  sessionApi: SessionApi
  router: ChatRouter
  /** turn/end 丢失时的投递看门狗（默认 10 分钟，测试可缩短）。 */
  turnTimeoutMs?: number
}

interface TurnState {
  queue: SemanticMessage[]
  running: boolean
}

/** 宿主会话事件的宽松形（信封 {type,seq,time,data}，只消费需要的事实）。 */
interface SessionEventLike {
  type?: string
  data?: {
    turn?: number
    step?: number
    reason?: { kind?: string }
    message?: { content?: Array<{ type?: string; text?: string }> }
  }
}

const TURN_END_SUFFIX: Record<string, string> = {
  aborted: '已取消',
  blocked: '被权限拦阻',
  error: '执行失败',
  'max-tokens': '达到输出长度上限',
  interrupted: '会话被中断',
}

/** 分段：优先段落边界，无边界硬切；maxLen 非正数/非有限 = 不分段。 */
export function splitText(text: string, maxLen: number): string[] {
  if (!Number.isFinite(maxLen) || maxLen <= 0 || text.length <= maxLen) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > maxLen) {
    const para = rest.lastIndexOf('\n\n', maxLen)
    const cut = para > 0 ? para : maxLen
    parts.push(rest.slice(0, cut))
    rest = para > 0 ? rest.slice(cut + 2) : rest.slice(cut)
  }
  if (rest.trim() !== '') parts.push(rest)
  return parts.length > 0 ? parts : [text]
}

/** assistant/message 事件的可见文本（只取 text 块，reasoning/工具块不上 IM）。 */
export function extractAssistantText(event: SessionEventLike): string {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n\n')
}

export class ImUnionEngine {
  private adapters = new Map<string, ChannelAdapter>()
  private policies = new Map<string, AccountPolicy>()
  private turns = new Map<string, TurnState>()
  private readonly log: LoggerLike

  constructor(private readonly deps: EngineDeps) {
    this.log = deps.ctx.logger('dsh-im-union')
  }

  registerAccount(adapter: ChannelAdapter, accountId: string, policy?: Partial<AccountPolicy>): void {
    this.adapters.set(adapter.id, adapter)
    this.policies.set(accountId, {
      dmAllowlist: new Set(policy?.dmAllowlist ?? []),
      groupEnabled: policy?.groupEnabled ?? true,
    })
    adapter.onMessage((message) => void this.handleInbound(accountId, message))
  }

  unregister(accountId: string): void {
    this.policies.delete(accountId)
  }

  private admitted(accountId: string, message: SemanticMessage): boolean {
    const adapter = this.adapters.get(message.address.channel)
    if (adapter === undefined) return false
    if (typeof adapter.authorize === 'function') {
      const verdict = adapter.authorize(message)
      if (verdict === true) return true
      if (verdict === false) return false
    }
    if (message.address.kind === 'group') {
      const policy = this.policies.get(accountId)
      return (policy?.groupEnabled ?? true) && shouldRespondToGroup(message.mentionedBot)
    }
    const policy = this.policies.get(accountId)
    if (policy === undefined) return false
    return policy.dmAllowlist.has(message.userId)
  }

  /** 入站主流程（M0：/help /status /new 三个命令 + 直通会话）。 */
  async handleInbound(accountId: string, message: SemanticMessage): Promise<void> {
    if (!this.admitted(accountId, message)) return
    const adapter = this.adapters.get(message.address.channel)!
    const key = `${message.address.channel}:${message.address.chatId}`

    const text = message.text.trim()
    if (text === '/help' || text === '/status') {
      await adapter.reply(message.address, this.helpText(text))
      return
    }
    if (text === '/new') {
      this.deps.router.unbind(message.address)
      await adapter.reply(message.address, '已解除会话绑定，下一条消息将开启新会话。')
      return
    }

    // 每聊天串行：运行中则排队。
    const state = this.turns.get(key) ?? { queue: [], running: false }
    this.turns.set(key, state)
    if (state.running) {
      state.queue.push(message)
      await adapter.reply(message.address, '当前任务进行中，已排队。')
      return
    }
    state.running = true
    try {
      await this.runTurn(adapter, message)
    } finally {
      state.running = false
      const next = state.queue.shift()
      if (next !== undefined) void this.handleInbound(accountId, next)
    }
  }

  private async runTurn(adapter: ChannelAdapter, message: SemanticMessage): Promise<void> {
    const { router, sessionApi } = this.deps
    const binding = router.resolve(message.address)
    const sessionId = binding.sessionId
    if (sessionApi.backend === 'none') {
      await adapter.reply(message.address, new UnsupportedError('会话后端').message)
      return
    }

    // 状态机：follow 先行收集 step 落定文本；turn/end（或看门狗）收轮后统一投递。
    const segments: string[] = []
    let endReason: string | undefined
    let wakeResolve: (() => void) | undefined
    let woke = false
    const wake = (): Promise<void> =>
      woke ? Promise.resolve() : new Promise<void>((resolve) => (wakeResolve = resolve))
    const markDone = (): void => {
      if (woke) return
      woke = true
      wakeResolve?.()
    }
    const canStream =
      (adapter.caps.editStream === true || adapter.caps.nativeStream === true) &&
      typeof adapter.beginStream === 'function'
    let stream: ReplyStream | undefined
    let streamBroken = false
    let progressChain: Promise<void> = Promise.resolve()
    const snapshot = (): string => segments.join('\n\n')
    const pushProgress = (): void => {
      if (!canStream || streamBroken) return
      progressChain = progressChain.then(async () => {
        if (streamBroken) return
        try {
          stream ??= await adapter.beginStream!(message.address)
          await stream.update(snapshot())
        } catch (error) {
          streamBroken = true
          this.log.warn(`流式编辑退化为首步落定前 reply：${(error as Error).message}`)
        }
      })
    }

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = sessionApi.follow(sessionId, (raw) => {
        const event = raw as SessionEventLike
        if (event?.type === 'assistant/message') {
          const text = extractAssistantText(event)
          if (text !== '') {
            segments.push(text)
            if (!streamBroken) pushProgress()
          }
        } else if (event?.type === 'turn/end' && endReason === undefined) {
          endReason = String(event.data?.reason?.kind ?? 'completed')
          markDone()
        }
      })
    } catch (error) {
      if (error instanceof UnsupportedError) {
        await adapter.reply(message.address, error.message)
        return
      }
      throw error
    }

    const timerMs = this.deps.turnTimeoutMs ?? 10 * 60 * 1000
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      await sessionApi.prompt(sessionId, message.text)
      await Promise.race([
        wake(),
        new Promise<void>((resolve) => {
          watchdog = setTimeout(() => {
            endReason = endReason ?? 'timeout'
            markDone()
            resolve()
            // 注：故意不 unref——看门狗就是本轮的唯一待完成工作，unref 会让
            // 事件循环提前排干（测试中表现为 pending 卡死级联取消）。
          }, timerMs)
        }),
      ])
      await progressChain

      const suffix =
        endReason !== undefined && endReason !== 'completed'
          ? `\n（本轮${endReason === 'timeout' ? '等待超时' : `提前结束：${TURN_END_SUFFIX[endReason] ?? endReason}`}）`
          : ''
      const finalText = (snapshot() + suffix).trim() === '' ? '本轮无可见输出。' : (snapshot() + suffix).trim()
      const parts = splitText(finalText, adapter.caps.maxMessageLength ?? 0)

      if (canStream && !streamBroken && stream !== undefined) {
        const receipt = await stream.finish(parts[0]).catch((error: Error) => {
          this.log.warn(`流式 finish 失败，降级补发: ${error.message}`)
          return undefined
        })
        if (receipt !== undefined) this.noteUncertain(receipt, '流式收尾')
        if (receipt === undefined) {
          await this.deliverParts(adapter, message, parts)
        } else {
          for (const extra of parts.slice(1)) await this.deliverOne(adapter, message, extra)
        }
      } else {
        await this.deliverParts(adapter, message, parts)
      }
    } catch (error) {
      if (error instanceof UnsupportedError) {
        await adapter.reply(message.address, error.message)
        return
      }
      const ref = `IMU-${Date.now().toString(36)}`
      this.log.error(`runTurn 失败: ${error instanceof Error ? error.message : String(error)}`)
      await adapter.reply(message.address, `任务提交失败，请查看本机日志（参考号 ${ref}）`)
      try {
        stream?.abort()
      } catch {
        // abort 失败不影响主路径。
      }
    } finally {
      clearTimeout(watchdog)
      try {
        unsubscribe?.()
      } catch {
        // 退订失败留给宿主生命周期。
      }
      if (!woke) markDone()
    }
  }

  private noteUncertain(receipt: Receipt, what: string): void {
    if (receipt.uncertain) this.log.warn(`${what} 投递结果不明，不自动重发（D7）`)
  }

  private async deliverParts(adapter: ChannelAdapter, message: SemanticMessage, parts: string[]): Promise<void> {
    for (const part of parts) await this.deliverOne(adapter, message, part)
  }

  private async deliverOne(adapter: ChannelAdapter, message: SemanticMessage, text: string): Promise<void> {
    const receipt = await adapter.reply(message.address, text)
    this.noteUncertain(receipt, adapter.id)
  }

  private helpText(command: string): string {
    if (command === '/status') {
      const caps = this.deps.caps
      return [
        'dsh-im-union 状态',
        `设置面代际: ${caps.settingsGeneration}`,
        `会话后端: ${this.deps.sessionApi.backend}`,
        `凭据: ${caps.credentials ? '宿主凭据库' : '文件 vault'}`,
      ].join('\n')
    }
    return ['可用命令（M0 骨架）：', '/help 本帮助', '/status 连接状态', '/new 重开会话'].join('\n')
  }
}

/** 给渠道层用的地址构造便利函数。 */
export function addressOf(channel: string, kind: 'dm' | 'group', chatId: string, threadId?: string): ChatAddress {
  return { channel, kind, chatId, threadId }
}
