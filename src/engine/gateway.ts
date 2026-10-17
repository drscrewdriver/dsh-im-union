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
import { ChatRouter, shouldRespondToGroup, type Binding, type ChatAddress } from './router.js'
import { chatOverrideKey, isCommandName, parseCommand, runCommand, type CommandDeps } from './commands.js'
import { InteractionBroker, type ChatSessionRef } from './interactions.js'
import type { ApprovalOutcome, ApprovalRequest, QuestionAnswer, QuestionRequest } from '../host-compat/interaction.js'
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
  /** 审批/提问等待上限（默认 5 分钟，红线 D5）。 */
  approvalTimeoutMs?: number
  /** 凭据载体形态（/status 展示：service=宿主凭据库 / file=文件 vault）。 */
  vaultKind?: string
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
  /** 按 accountId 键控（E3：同渠道多账号互不覆盖；入站由产生消息的账号适配器投递）。 */
  private accounts = new Map<string, { adapter: ChannelAdapter; policy: AccountPolicy }>()
  private turns = new Map<string, TurnState>()
  private selections = new Map<string, { model?: string; provider?: string; reasoningEffort?: string }>()
  private workspaceOverrides = new Map<string, string>()
  /** 宿主会话 id → 最近发起任务的聊天（审批/提问的回路由表，T1.9）。 */
  private sessionChats = new Map<string, ChatSessionRef>()
  private readonly broker: InteractionBroker
  private readonly log: LoggerLike

  constructor(private readonly deps: EngineDeps) {
    this.log = deps.ctx.logger('dsh-im-union')
    this.broker = new InteractionBroker({
      resolveChat: (sessionId) => this.sessionChats.get(sessionId),
      getAdapter: (accountId) => this.accounts.get(accountId)?.adapter,
      timeoutMs: deps.approvalTimeoutMs,
      logWarn: (msg) => this.log.warn(msg),
    })
  }

  registerAccount(adapter: ChannelAdapter, accountId: string, policy?: Partial<AccountPolicy>): void {
    this.accounts.set(accountId, {
      adapter,
      policy: {
        dmAllowlist: new Set(policy?.dmAllowlist ?? []),
        groupEnabled: policy?.groupEnabled ?? true,
      },
    })
    adapter.onMessage((message) => void this.handleInbound(accountId, message))
  }

  unregister(accountId: string): void {
    this.accounts.delete(accountId)
    // 拆除连带：该账号的 pending 审批全部取消（fail-closed），回路由表清理。
    this.broker.dropAccount(accountId)
    for (const [sid, ref] of [...this.sessionChats]) {
      if (ref.accountId === accountId) this.sessionChats.delete(sid)
    }
  }

  /** 审批接管入口（index.ts 传给 attachInteraction）。 */
  handleApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    return this.broker.handleApproval(request, next)
  }

  handleQuestion(request: QuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    return this.broker.handleQuestion(request, next)
  }

  private admitted(accountId: string, message: SemanticMessage): boolean {
    const account = this.accounts.get(accountId)
    if (account === undefined) return false
    const adapter = account.adapter
    if (typeof adapter.authorize === 'function') {
      const verdict = adapter.authorize(message)
      if (verdict === true) return true
      if (verdict === false) return false
    }
    if (message.address.kind === 'group') {
      return account.policy.groupEnabled && shouldRespondToGroup(message.mentionedBot)
    }
    return account.policy.dmAllowlist.has(message.userId)
  }

  /** 入站主流程：命令面板（T1.1）先分派，非命令入会话队列。 */
  async handleInbound(accountId: string, message: SemanticMessage): Promise<void> {
    const adapter = this.accounts.get(accountId)?.adapter
    if (adapter === undefined || !this.admitted(accountId, message)) return
    // 审批/提问回复优先消费（发起者限定在 broker 内裁决，D5）。
    if (this.broker.consumeInbound(accountId, message.address, message.userId, message.text)) return
    const key = `${message.address.channel}:${message.address.chatId}`

    const text = message.text.trim()
    const command = parseCommand(text)
    if (command !== undefined && isCommandName(command.name)) {
      // resolve 对未绑定聊天登记的隐式绑定与 runTurn 惰性解析同值，无额外副作用。
      const sessionId = this.deps.router.resolve(message.address).sessionId
      const reply = await runCommand(this.commandDeps(), message.address, sessionId, command)
      if (reply !== '') await adapter.reply(message.address, reply)
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
      await this.runTurn(adapter, message, accountId)
    } finally {
      state.running = false
      const next = state.queue.shift()
      if (next !== undefined) void this.handleInbound(accountId, next)
    }
  }

  private commandDeps(): CommandDeps {
    return {
      sessionApi: this.deps.sessionApi,
      router: this.deps.router,
      caps: this.deps.caps,
      selections: this.selections,
      workspaceOverrides: this.workspaceOverrides,
      vaultKind: this.deps.vaultKind ?? 'file',
      logWarn: (msg) => this.log.warn(msg),
    }
  }

  /**
   * 隐式 imu: 形 id → 宿主真会话 id：首次使用时 createSession 并绑定；
   * 失败则继续用隐式 id（老线/降级面下 follow/prompt 自有报错路径，不阻断命令面）。
   */
  private async ensureSessionId(address: ChatAddress, binding: Binding): Promise<string> {
    const { sessionApi, router } = this.deps
    if (sessionApi.backend !== 'native' || !binding.sessionId.startsWith('imu:')) return binding.sessionId
    try {
      const workspace = this.workspaceOverrides.get(chatOverrideKey(address))
      const info = await sessionApi.createSession({
        sessionIdHint: binding.sessionId,
        ...(workspace !== undefined ? { workspace } : {}),
      })
      router.bind(address, info.id)
      return info.id
    } catch (error) {
      this.log.warn(`createSession 失败，继续使用隐式 id: ${(error as Error).message}`)
      return binding.sessionId
    }
  }

  private async runTurn(adapter: ChannelAdapter, message: SemanticMessage, accountId: string): Promise<void> {
    const { router, sessionApi } = this.deps
    const binding = router.resolve(message.address)
    const sessionId = await this.ensureSessionId(message.address, binding)
    // 审批回路由登记：后发起的任务覆盖先前记录（与活跃任务一致）。
    this.sessionChats.set(sessionId, { accountId, address: message.address, userId: message.userId })
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
}

/** 给渠道层用的地址构造便利函数。 */
export function addressOf(channel: string, kind: 'dm' | 'group', chatId: string, threadId?: string): ChatAddress {
  return { channel, kind, chatId, threadId }
}
