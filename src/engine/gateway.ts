/**
 * IM 引擎网关：入站消息 → 准入 → 命令/会话 → 投递。
 *
 * 姿态：
 * - 默认拒绝（红线 D5/D6）：私聊白名单为空即拒（扫码者自动入表在 M1 渠道层做）；
 *   群聊仅显式 @ 触发；
 * - 每聊天串行队列：当前任务未完不并发下一条（排队语义，插话 /steer P1）；
 * - 投递走 adapter.reply/Receipt：uncertain 不重发。
 */
import type { CordisLike, LoggerLike } from '../types.js'
import type { UnionCapabilities } from '../host-compat/services.js'
import type { SessionApi } from '../host-compat/session-api.js'
import { UnsupportedError } from '../host-compat/session-api.js'
import { ChatRouter, shouldRespondToGroup, type ChatAddress } from './router.js'
import type { ChannelAdapter, SemanticMessage } from '../channels/types.js'

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
}

interface TurnState {
  queue: SemanticMessage[]
  running: boolean
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
    try {
      if (sessionApi.backend === 'none') throw new UnsupportedError('会话后端')
      await sessionApi.prompt(binding.sessionId, message.text)
      // M0 骨架：完整的事件流→流式投递状态机在 M1 随首个真渠道落地
      // （follow 订阅、assistant 文本聚合、审批/提问接管、分段与 caps 降级）。
      await adapter.reply(message.address, '（M0 骨架）任务已提交到 Harness，回复投递链路待 M1 渠道层接通。')
    } catch (error) {
      const text =
        error instanceof UnsupportedError
          ? error.message
          : `任务提交失败，请查看本机日志（参考号 IMU-${Date.now().toString(36)}）`
      if (!(error instanceof UnsupportedError)) {
        this.log.error(`runTurn 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
      await adapter.reply(message.address, text)
    }
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
