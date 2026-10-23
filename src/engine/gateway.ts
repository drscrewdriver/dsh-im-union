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
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { CordisLike, LoggerLike } from '../types.js'
import type { UnionCapabilities } from '../host-compat/services.js'
import type { SessionApi } from '../host-compat/session-api.js'
import { UnsupportedError } from '../host-compat/session-api.js'
import type { SessionEventTap } from '../host-compat/session-event-tap.js'
import { ChatRouter, chatKey, shouldRespondToGroup, type Binding, type ChatAddress } from './router.js'
import { chatOverrideKey, isCommandName, parseCommand, runCommand, type CommandDeps } from './commands.js'
import { InteractionBroker, type ChatSessionRef } from './interactions.js'
import { prepareImages, toPromptParts, visionSupported } from './media.js'
import { withQuoteContext } from './quote.js'
import { sessionTitle } from '../host-compat/session-source.js'
import { prepareFiles, filesUnavailableNote, fileOutUnavailableNote } from './files.js'
import { filePromptPart, type UploadsCompat } from '../host-compat/uploads-compat.js'
import { extractDeliverables, type DeliverableRef, type DeliverablesCompat } from '../host-compat/deliverables-compat.js'
import { DeliveryLog, MAX_RETRY, type DeliveryStatus } from './delivery-log.js'
import { FragmentBuffer } from './fragments.js'
import { zipSync } from './zip.js'
import { withFileLog } from '../plugin-log.js'
import type { ApprovalOutcome, ApprovalRequest, QuestionAnswer, QuestionRequest } from '../host-compat/interaction.js'
import type { ChannelAdapter, Receipt, ReplyStream, SemanticMessage } from '../channels/types.js'
import type { RelayStore } from './relay.js'
import { sanitizeImReply } from './reply-sanitize.js'
import { renderSvgToPng } from './svg-render.js'

export interface AccountSessionPrefs {
  /** 会话工作目录（宿主 session.create 的 cwd，直接决定 Agent 的项目目录）。 */
  cwd?: string
  /** Agent 预设 id（session.create 的 agentPreset）。 */
  agentPreset?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  /** 权限预设（宿主 permissionPresets.set：沙箱模式+审批策略一并落位）。 */
  permission?: string
}

/** 命令执行开关（私聊/群聊各一档；缺省都开——命令面板是排障入口）。 */
export interface CommandExecPolicy {
  dm: boolean
  group: boolean
}

export function normalizeCommandExec(input: unknown, fallback?: CommandExecPolicy): CommandExecPolicy {
  const base: CommandExecPolicy = fallback ?? { dm: true, group: true }
  if (input === null || typeof input !== 'object') return { ...base }
  const raw = input as Record<string, unknown>
  return {
    dm: typeof raw.dm === 'boolean' ? raw.dm : base.dm,
    group: typeof raw.group === 'boolean' ? raw.group : base.group,
  }
}

export interface AccountPolicy {
  /** 私聊白名单 userId 集合；空集合=拒绝所有私聊（扫码自动入表由渠道层维护）。 */
  dmAllowlist: Set<string>
  /** 群聊总开关（默认开，触发仍需 @）。 */
  groupEnabled: boolean
  /** 私聊准入档位：approved=仅白名单（默认拒绝红线默认值）；all=接受所有私聊（用户显式开启）。 */
  privateAccess: 'approved' | 'all'
  /** 命令面板可执行性（im-connect 同款语义：关闭只拦 / 命令，普通对话不受影响）。 */
  commandExec: CommandExecPolicy
  /** 账号级会话偏好：仅在该账号**新建**会话时生效，已有会话不受影响。 */
  session?: AccountSessionPrefs
  /** 人类可读别名（0.4.7）：`/relay` 等命令面可用别名代替代理键 accountId（唯一才解）。 */
  alias?: string
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
  // —— M2 能力包（T2.4/T2.5/T2.8/T2.9；缺位=相应命令/链路降级，E1）——
  deliveryLog?: DeliveryLog
  uploads?: UploadsCompat
  deliverables?: DeliverablesCompat
  fragments?: FragmentBuffer
  /** 私聊入站观察（主动投递 T2.6 双向同步：admitted 前也要喂，
   *  白名单外的私聊正是 syncBack 候选来源）。 */
  onInboundDm?: (accountId: string, message: SemanticMessage) => void
  /** /export 渠道文件面缺位时的本地落盘目录。 */
  exportDir?: string
  /** 拒绝提示冷却（默认 10 分钟；测试可缩短）。 */
  rejectNoticeCooldownMs?: number
  /** 会话事件总线（0.3.8）：session/event firehose 扇出面；缺位回退 sessionApi.follow。 */
  eventTap?: SessionEventTap
  /** relay 绑定存储（Phase 8）；缺位=抄送链路静默跳过。 */
  relayStore?: RelayStore
  /** 模型白名单（Phase 7，插件级）；空数组=不限（现状兼容）。 */
  modelWhitelist?: string[]
  /** IM 回复纪律前缀（0.4.5，默认**关**）：预设层（im-concise）已从源头压制富结构；
   *  本开关仅留给「预设不可用的老宿主」降级用（每回合拼接，会让用户消息累积成本）。 */
  imReplyDiscipline?: boolean
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
    name?: string
    callId?: string
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

/**
 * IM 回复纪律前缀（0.4.5）：用户实敲——微信只能看纯文字，而 genui（```dsh-ui）
 * 与 dsh-raw-html-v2（裸 HTML）会把富结构写进正文。用现场前缀做最高优先级覆盖，
 * 并给 SVG 图表开一扇门（插件转图片发送）。
 */
const IM_REPLY_DISCIPLINE = [
  '[IM 渠道纪律（最高优先级，覆盖其它技能/插件的渲染引导）]',
  '你在 IM 渠道对话：',
  '1) 简短纯文字优先，先给结论，尽量 ≤800 字；',
  '2) 禁止富结构输出：不要用 ```dsh-ui / ```html 围栏、裸 HTML 标签（div/vcp-root/style 等）或组件 JSON——IM 端只会显示源码噪声；',
  '3) 需要图表/示意图时，只输出一个 ```svg 围栏（完整内联 <svg>，白底深色前景，viewBox 自适应，宽度 ≤1000），系统会转成图片发送；',
  '4) 不要重复解释；不贴大段代码，除非用户明确要求。',
].join('\n')

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

/** 会话 id 尾段缩写（日志/reply 标签用，与 commands.ts 同源语义）。 */
function shortId(sessionId: string): string {
  const tail = sessionId.split(':').filter(Boolean)
  return (tail[tail.length - 1] ?? sessionId).slice(0, 12)
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
  /** 静音聊天（/mute，T2.8）：admitted 后、命令前静默丢弃。 */
  private muted = new Set<string>()
  /** /goal 目标备忘（chatKey → 文本，IM 侧存储不碰宿主）。 */
  private goals = new Map<string, string>()
  /** 拒绝提示冷却键（账号+用户 / 账号+群）：窗口内只提示一次，防回复风暴。 */
  private rejectionNotices = new Set<string>()
  /** chatKey → 最近一次 createSession 失败原因（runTurn 报错时关联根因，成功即清）。 */
  private lastEnsureFailure = new Map<string, string>()
  /** chatKey → /sessions 最近所见列表（/session <序号> 的 15 分钟取用缓存，≤256 条）。 */
  private readonly sessionChoices = new Map<string, { ids: string[]; at: number }>()
  /** 相对 cwd 偏好已告警过的 account+cwd（只告警一次防刷屏）。 */
  private relativeCwdWarned = new Set<string>()
  /** 投递 seq → 原文全文（/delivery retry 补发用；重启即清，摘要在盘）。 */
  private outbox = new Map<number, string>()
  /** 碎片合并的上一次私聊消息上下文（submit 回调重建 SemanticMessage）。 */
  private fragmentLast = new Map<string, { accountId: string; message: SemanticMessage }>()
  /** 超时后的迟到结果订阅（T2.9，每聊天一个，新回合覆盖旧的）。 */
  private lateFollows = new Map<string, { dispose: () => void }>()
  private readonly broker: InteractionBroker
  private readonly log: LoggerLike
  /** 插件默认 agent 预设（0.4.6）：账号未指定时的会话缺省（由 index 按宿主可见性设置）。 */
  private defaultAgentPreset?: string

  constructor(private readonly deps: EngineDeps) {
    this.log = withFileLog(deps.ctx.logger('dsh-im-union'))
    this.broker = new InteractionBroker({
      resolveChat: (sessionId) => this.sessionChats.get(sessionId),
      getAdapter: (accountId) => this.accounts.get(accountId)?.adapter,
      timeoutMs: deps.approvalTimeoutMs,
      logWarn: (msg) => this.log.warn(msg),
    })
  }

  // —— Phase 7/8 访问器（admin 端点用）———
  getModelWhitelist(): string[] {
    return this.deps.modelWhitelist ?? []
  }
  setModelWhitelist(wl: string[]): void {
    if (this.deps.modelWhitelist !== undefined) this.deps.modelWhitelist.length = 0
    else (this.deps as { modelWhitelist?: string[] }).modelWhitelist = []
    this.deps.modelWhitelist!.push(...wl)
  }
  getRelayStore(): RelayStore | undefined {
    return this.deps.relayStore
  }

  /** 设置插件默认预设（0.4.6）；传 undefined 撤销。 */
  setDefaultAgentPreset(id: string | undefined): void {
    this.defaultAgentPreset = id
  }
  getDefaultAgentPreset(): string | undefined {
    return this.defaultAgentPreset
  }

  registerAccount(adapter: ChannelAdapter, accountId: string, policy?: Partial<AccountPolicy>): void {
    this.accounts.set(accountId, {
      adapter,
      policy: {
        dmAllowlist: new Set(policy?.dmAllowlist ?? []),
        groupEnabled: policy?.groupEnabled ?? true,
        privateAccess: policy?.privateAccess === 'all' ? 'all' : 'approved',
        commandExec: normalizeCommandExec(policy?.commandExec),
        ...(policy?.session !== undefined ? { session: policy.session } : {}),
        ...(policy?.alias !== undefined && policy.alias !== '' ? { alias: policy.alias } : {}),
      },
    })
    adapter.onMessage((message) => void this.handleInbound(accountId, message))
  }

  /**
   * 通知账号解析（0.4.7）：代理键直查优先，缺位再按别名匹配。
   * 别名不唯一时 ambiguous=true——绝不猜账号（与主动投递「歧义不猜」同纪）。
   */
  private resolveNotifyAccount(input: string): { id?: string; ambiguous?: boolean } {
    if (this.accounts.has(input)) return { id: input }
    const hits: string[] = []
    for (const [accountId, entry] of this.accounts) {
      if (entry.policy.alias !== undefined && entry.policy.alias === input) hits.push(accountId)
    }
    if (hits.length === 1) return { id: hits[0] }
    if (hits.length > 1) return { ambiguous: true }
    return {}
  }

  /** 凭据无关的编辑（别名/白名单/准入档位/会话偏好）原位同步策略，不重建适配器。 */
  updatePolicy(accountId: string, policy: Partial<AccountPolicy>): void {
    const entry = this.accounts.get(accountId)
    if (entry === undefined) return
    const prevPermission = entry.policy.session?.permission ?? ''
    entry.policy = {
      dmAllowlist: new Set(policy.dmAllowlist ?? entry.policy.dmAllowlist),
      groupEnabled: policy.groupEnabled ?? entry.policy.groupEnabled,
      privateAccess: policy.privateAccess === 'all' || policy.privateAccess === 'approved'
        ? policy.privateAccess
        : entry.policy.privateAccess,
      commandExec: normalizeCommandExec(policy.commandExec ?? entry.policy.commandExec),
      session: policy.session !== undefined ? policy.session : entry.policy.session,
      // 别名原位同步：传空串=清空，不传（undefined）=保持原值。
      ...(policy.alias !== undefined
        ? policy.alias !== ''
          ? { alias: policy.alias }
          : {}
        : entry.policy.alias !== undefined
          ? { alias: entry.policy.alias }
          : {}),
    }
    // 偏好改即生效：权限预设对该账号已回路的会话逐个补应用（新建会话由 create 面自落）。
    const nextPermission = entry.policy.session?.permission ?? ''
    if (nextPermission !== '' && nextPermission !== prevPermission) {
      for (const [sid, ref] of [...this.sessionChats]) {
        if (ref.accountId !== accountId) continue
        this.deps.sessionApi
          .applyPermission(sid, nextPermission)
          .then((verdict) => {
            if (!verdict.ok) this.log.warn(`权限预设未落位（${sid}）: ${verdict.message ?? ''}`)
          })
          .catch(() => {})
      }
    }
  }

  unregister(accountId: string): void {
    this.accounts.delete(accountId)
    // 拆除连带：该账号的 pending 审批全部取消（fail-closed），回路由表清理。
    this.broker.dropAccount(accountId)
    for (const [sid, ref] of [...this.sessionChats]) {
      if (ref.accountId === accountId) this.sessionChats.delete(sid)
    }
    for (const [key, last] of [...this.fragmentLast]) {
      if (last.accountId === accountId) {
        this.fragmentLast.delete(key)
        this.deps.fragments?.drop(key)
        this.lateFollows.get(key)?.dispose()
      }
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
    // 私聊准入两档（D6 默认拒绝仍在）：approved=仅白名单；all=用户显式放行所有私聊。
    if (account.policy.privateAccess === 'all') return true
    return account.policy.dmAllowlist.has(message.userId)
  }

  /**
   * 拒绝可见化（排障关键）：白名单/准入拒绝曾是纯静默丢弃，用户表现为
   * 「发消息无反应」无从诊断。现在私聊拒绝回一次带 userId 的提示（每用户
   * 冷却窗口内只提示一次，避免对陌生人的回复风暴）；群聊仅在显式 @ 且
   * 群开关关闭时提示，未 @ 的静默丢弃保持不变。
   */
  private async rejectInbound(accountId: string, message: SemanticMessage): Promise<void> {
    const cooldownMs = this.deps.rejectNoticeCooldownMs ?? 10 * 60 * 1000
    const adapter = this.accounts.get(accountId)?.adapter
    if (adapter === undefined) return
    if (message.address.kind === 'group') {
      if (!message.mentionedBot) return
      if (!this.accounts.get(accountId)!.policy.groupEnabled) {
        const key = `${accountId}:group:${message.address.chatId}`
        if (this.rejectionNotices.has(key)) return
        this.rejectionNotices.add(key)
        try {
          await adapter.reply(message.address, '本账号群聊接收已关闭：请在设置面板打开该账号的群聊开关。')
        } catch {
          // 提示投递失败不溯源（拒绝路径本来就不处理消息）。
        }
      }
      return
    }
    const key = `${accountId}:${message.userId}`
    if (this.rejectionNotices.has(key)) return
    this.rejectionNotices.add(key)
    setTimeout(() => this.rejectionNotices.delete(key), cooldownMs)
    try {
      await adapter.reply(
        message.address,
        `未授权私聊：本账号私聊准入为「仅已批准用户」。\n` +
          `请让管理员把你的用户 ID（${message.userId}）加入白名单，或在设置面板把私聊准入改为「所有私聊」。`,
      )
    } catch {
      // 同上：提示失败静默。
    }
  }

  /** 入站主流程：命令面板（T1.1）先分派，非命令入会话队列。 */
  async handleInbound(accountId: string, message: SemanticMessage): Promise<void> {
    const adapter = this.accounts.get(accountId)?.adapter
    if (adapter === undefined) return
    // 入站可见性（排障基线）：此后任何分支（拒绝/命令/回合）都应能在日志对上号。
    this.log.info(`入站：${message.address.channel}/${message.address.kind} 自 ${message.userId}`)
    // 主动投递双向同步观察（T2.6）：必须在 admitted 之前——白名单外的私聊
    // 正是 syncBack 候选来源；只喂 dm。
    if (message.address.kind === 'dm') this.deps.onInboundDm?.(accountId, message)
    if (!this.admitted(accountId, message)) {
      await this.rejectInbound(accountId, message)
      return
    }
    // 审批/提问回复优先消费（发起者限定在 broker 内裁决，D5）。
    if (this.broker.consumeInbound(accountId, message.address, message.userId, message.text)) return
    const key = `${message.address.channel}:${message.address.chatId}`

    const text = message.text.trim()
    const command = parseCommand(text)
    if (command !== undefined && isCommandName(command.name)) {
      // 命令执行开关（im-connect 同款语义）：关闭只拦 / 命令并明说，普通对话不受影响。
      // 开关判定在静音解除之前放行例外：/mute 仍需可用（否则永久静默）——静音聊天
      // 的命令门在下方 muted 判定处自然拦截，这里只挡非 /mute 的执行面。
      const kind = message.address.kind === 'group' ? 'group' : 'dm'
      const entry = this.accounts.get(accountId)!
      if (!entry.policy.commandExec[kind] && command.name !== 'mute') {
        await adapter.reply(
          message.address,
          kind === 'group'
            ? '本账号群聊命令执行已关闭：普通对话不受影响；管理员可在设置面板重新开启。'
            : '本账号私聊命令执行已关闭：普通对话不受影响；管理员可在设置面板重新开启。',
        )
        return
      }
      // 命令在静音判定之前：静音期必须还能 /mute 解除（否则永久静默）。
      // resolve 对未绑定聊天登记的隐式绑定与 runTurn 惰性解析同值，无额外副作用。
      const sessionId = this.deps.router.resolve(message.address).sessionId
      const reply = await runCommand(this.commandDeps(accountId), message.address, sessionId, command)
      if (reply !== '') await adapter.reply(message.address, reply)
      return
    }
    // 静音聊天：非命令消息静默丢弃（T2.8）。
    if (this.muted.has(chatKey(message.address))) return

    // 碎片续写前置（T2.8，仅私聊；群聊多用户串碎片=事故）。
    if (this.deps.fragments !== undefined && message.address.kind === 'dm') {
      const verdict = await this.deps.fragments.accept(chatKey(message.address), message.text, true)
      if (verdict.handled) {
        this.fragmentLast.set(chatKey(message.address), { accountId, message })
        if (verdict.action === 'empty') await adapter.reply(message.address, '没有待提交的碎片。')
        else if (verdict.action === 'held') await adapter.reply(message.address, `🧩 已挂起 ${verdict.count} 段：以 .. 结尾继续，单独发 !! 立即提交。`)
        return
      }
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

  private commandDeps(accountId: string): CommandDeps {
    return {
      sessionApi: this.deps.sessionApi,
      router: this.deps.router,
      caps: this.deps.caps,
      selections: this.selections,
      workspaceOverrides: this.workspaceOverrides,
      vaultKind: this.deps.vaultKind ?? 'file',
      logWarn: (msg) => this.log.warn(msg),
      deliveryLog: this.deps.deliveryLog,
      retryDelivery: (seq) => this.retryDelivery(seq),
      exportChat: (address, sessionId) => this.exportChat(address, sessionId),
      queueInfo: (address) => {
        const state = this.turns.get(`${address.channel}:${address.chatId}`)
        return { running: state?.running === true, pending: state?.queue.length ?? 0 }
      },
      toggleMute: (address) => {
        const key = chatKey(address)
        if (this.muted.has(key)) {
          this.muted.delete(key)
          return '本聊天已恢复接收。'
        }
        this.muted.add(key)
        return '本聊天已静音：宿主不再处理你的消息（/mute 再次切换恢复）；投递日志与网页端不受影响。'
      },
      goals: this.goals,
      // /speak（T3.5）：只寻真正装了语音面的适配器（飞书语音档），其余渠道如实降级。
      speakText: async (address, text) => {
        for (const entry of this.accounts.values()) {
          if (entry.adapter.id !== address.channel || typeof entry.adapter.speak !== 'function') continue
          try {
            const receipt = await entry.adapter.speak(address, text)
            this.noteUncertain(receipt, '语音投递')
            return receipt.uncertain ? '语音已发送但结果不明（不自动重发）。' : '已语音送出。'
          } catch (error) {
            this.log.warn(`speak 失败: ${(error as Error).message}`)
            return '语音发送失败（原因已记入本机日志）。'
          }
        }
        return '当前渠道不支持语音输出（或未开启语音档）。'
      },
      // /new 轮换（0.4.0）：确定性 id 下解绑重建=同会话（desktop 实证 /new 无效），
      // 轮换带 13 位毫秒纪元并转历史；busy 守卫用回合队列的 running 位。
      rotateSession: (address) => this.rotateSessionFor(address, accountId),
      isChatBusy: (address) => this.turns.get(`${address.channel}:${address.chatId}`)?.running === true,
      sessionChoices: this.sessionChoices,
      modelWhitelist: this.deps.modelWhitelist ?? [],
      relay: this.deps.relayStore !== undefined ? {
        list: async (sid) => {
          const all = this.deps.relayStore!.list().filter((b) => b.sessionId === sid)
          if (all.length === 0) return '本会话未绑定抄送通知。\n绑定：/relay <通知账号 ID|别名>（钉钉无需目标，QQ 用 账号:openid|group_openid）；解绑：/relay -'
          return `已绑通知账号：${all.map((b) => b.notifyAccountId).join(', ')}`
        },
        bind: async (sid, notifyAccountId) => {
          // 支持 "账号|别名[:targetId]" 形（qq-notify 等需显式推送目标）
          const colon = notifyAccountId.indexOf(':')
          const accInput = colon > 0 ? notifyAccountId.slice(0, colon) : notifyAccountId
          const targetId = colon > 0 ? notifyAccountId.slice(colon + 1) : undefined
          const resolved = this.resolveNotifyAccount(accInput)
          if (resolved.ambiguous === true) {
            return `别名 ${accInput} 匹配到多个账号，请改用账号 ID（设置页账号行可见）。`
          }
          if (resolved.id === undefined) return `通知账号 ${accInput} 不存在或已注销（可填账号 ID 或别名）。`
          const accId = resolved.id
          this.deps.relayStore!.bind(sid, accId, targetId)
          return `已绑定抄送通知：${accId}${targetId !== undefined ? ` → ${targetId}` : ''}。本会话每回合 final 将自动推送至该渠道。`
        },
        unbind: async (sid) => {
          const removed = this.deps.relayStore!.unbind(sid)
          return removed ? '已解除抄送绑定。' : '本会话未绑定抄送通知。'
        },
      } : undefined,
    }
  }

  /**
   * /new 轮换执行面：先建新会话（与入站 ensure 同源偏好链），宿主可能改派 id，
   * 以返回为准；创建失败（lastEnsureFailure 在位——ensure 成功即清）保持旧绑定并抛错。
   */
  private async rotateSessionFor(address: ChatAddress, accountId: string): Promise<string> {
    const key = chatKey(address)
    this.lastEnsureFailure.delete(key)
    const oldSessionId = this.deps.router.resolve(address).sessionId
    const hint = this.deps.router.makeRotatedSessionId(address)
    const created = await this.ensureSessionId(address, { sessionId: hint, explicit: false }, accountId)
    if (this.lastEnsureFailure.has(key)) {
      throw new Error(this.lastEnsureFailure.get(key) ?? '会话创建失败')
    }
    this.deps.router.rotate(address, created, oldSessionId)
    this.log.info(`会话轮换：${oldSessionId} → ${created}（旧会话转入历史）`)
    return created
  }

  /**
   * 隐式 im:union: 形 id → 宿主真会话 id：首次使用时 createSession 并绑定；
   * 失败则继续用隐式 id（老线/降级面下 follow/prompt 自有报错路径，不阻断命令面）。
   * 账号级会话偏好（cwd/预设/模型）只在这一刻应用——新会话生效，存量会话不动。
   */
  private async ensureSessionId(address: ChatAddress, binding: Binding, accountId: string, title?: string): Promise<string> {
    const { sessionApi, router } = this.deps
    if (sessionApi.backend !== 'native' || !binding.sessionId.startsWith('im:')) return binding.sessionId
    const prefs = this.accounts.get(accountId)?.policy.session
    const addressKey = chatKey(address)
    const workspace = this.workspaceOverrides.get(chatOverrideKey(address))
    // cwd 只收绝对路径：宿主 create 把 cwd 原样透传 ensureSession（commands.ts:98-107），
    // 相对路径落在宿主进程 cwd 下不可控（真机实证：偏好填了裸目录名导致建会话失败）。
    const cwdPref = workspace === undefined ? (prefs?.cwd ?? '') : ''
    const presetChoice =
      prefs?.agentPreset !== undefined && prefs.agentPreset !== '' ? prefs.agentPreset : this.defaultAgentPreset
    const cwdUsable = cwdPref !== '' && isAbsolute(cwdPref)
    if (cwdPref !== '' && !cwdUsable && !this.relativeCwdWarned.has(`${accountId}:${cwdPref}`)) {
      this.relativeCwdWarned.add(`${accountId}:${cwdPref}`)
      this.log.warn(
        `账号 ${accountId} 的工作区目录偏好「${cwdPref}」不是绝对路径，已忽略（宿主默认工作区生效）；请在设置面板填写完整路径`,
      )
    }
    try {
      const info = await sessionApi.createSession({
        sessionIdHint: binding.sessionId,
        ...(workspace !== undefined ? { workspace } : {}),
        ...(cwdUsable ? { cwd: cwdPref } : {}),
        // 预设链（0.4.6）：账号级 agentPreset > 插件默认（im-concise，预设层屏蔽富结构）。
        ...(presetChoice !== undefined && presetChoice !== '' ? { preset: presetChoice } : {}),
        ...(prefs?.model !== undefined && prefs.model !== ''
          ? { model: prefs.model, ...(prefs.provider !== undefined && prefs.provider !== '' ? { provider: prefs.provider } : {}), ...(prefs.reasoningEffort !== undefined && prefs.reasoningEffort !== '' ? { reasoningEffort: prefs.reasoningEffort } : {}) }
          : {}),
        ...(prefs?.permission !== undefined && prefs.permission !== '' ? { permission: prefs.permission } : {}),
        ...(title !== undefined && title !== '' ? { title } : {}),
      })
      router.bind(address, info.id)
      // 请求 id 与宿主实际 id 可能不同（宿主可改派）：排障时对 UI 会话列表的关键证据。
      if (info.id !== binding.sessionId) {
        this.log.info(`会话已创建：请求 id ${binding.sessionId} → 宿主实际 id ${info.id}`)
      }
      this.lastEnsureFailure.delete(addressKey)
      // 账号级模型偏好同步喂给视觉判定（selections 以 chatKey 键控）。
      if (prefs?.model !== undefined && prefs.model !== '') {
        this.selections.set(chatKey(address), {
          model: prefs.model,
          ...(prefs.provider !== undefined && prefs.provider !== '' ? { provider: prefs.provider } : {}),
          ...(prefs.reasoningEffort !== undefined && prefs.reasoningEffort !== '' ? { reasoningEffort: prefs.reasoningEffort } : {}),
        })
      }
      return info.id
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastEnsureFailure.set(addressKey, message)
      this.log.warn(`createSession 失败，继续使用隐式 id: ${message}`)
      return binding.sessionId
    }
  }

  private async runTurn(adapter: ChannelAdapter, message: SemanticMessage, accountId: string): Promise<void> {
    const { router, sessionApi } = this.deps
    const binding = router.resolve(message.address)
    // 会话列表渠道角标（T3.6）：首次建会话时把 `[渠道] 首条正文` 透传给 title。
    const sessionId = await this.ensureSessionId(
      message.address,
      binding,
      accountId,
      sessionTitle(message.address.channel, message.text),
    )
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

    // 图片输入（T1.7）：宿主 capability 元数据判视觉（E4，不按模型名猜）；
    // notes 回给渠道用户，不混进模型 prompt。
    // 引用上下文（T3.6）：渠道已归一/回取的 quoteText 拼进正文尾部（无引用即原样）。
    // IM 回复纪律（0.4.5）：前缀拼在用户正文之前——压制 genui/html 富结构输出。
    const basePrompt = withQuoteContext(message.text, message.quoteText)
    const promptText =
      this.deps.imReplyDiscipline === true ? `${IM_REPLY_DISCIPLINE}\n\n${basePrompt}` : basePrompt
    let promptInput: string | unknown[] = promptText
    const inboundImages = message.images ?? []
    if (inboundImages.length > 0) {
      const supported = await visionSupported(this.deps.caps, this.selections.get(chatKey(message.address)))
      const prepared = prepareImages(
        inboundImages.map((image) => ({ name: image.name, data: image.data, mimeType: image.mimeType })),
        supported,
      )
      if (prepared.notes.length > 0) await adapter.reply(message.address, prepared.notes.join('\n'))
      promptInput = toPromptParts(promptText, prepared)
    }
    // 文件输入（T2.4）：上传面在位→{type:'file',receiptId} parts；
    // 缺位→纯文本回退（文件名/大小清单进 prompt，不假装内容已可读）。
    const inboundFiles = message.files ?? []
    if (inboundFiles.length > 0) {
      const preparedFiles = prepareFiles(inboundFiles.map((f) => ({ name: f.name, data: f.data })))
      if (preparedFiles.notes.length > 0) await adapter.reply(message.address, preparedFiles.notes.join('\n'))
      const fileParts: Array<Record<string, unknown>> = []
      const degraded: Array<{ name: string; data: Uint8Array }> = []
      const uploadsApi = this.deps.uploads
      for (const file of preparedFiles.accepted) {
        if (uploadsApi !== undefined && uploadsApi.mode !== 'none') {
          const result = await uploadsApi.upload(sessionId, file)
          if (result.receiptId !== undefined) fileParts.push(filePromptPart(result.receiptId))
          else degraded.push(file)
        } else {
          degraded.push(file)
        }
      }
      const baseParts: unknown[] =
        typeof promptInput === 'string' ? [{ type: 'text', text: promptInput }] : promptInput
      if (degraded.length > 0) {
        const note = filesUnavailableNote(degraded)
        const head = baseParts[0] as { type?: string; text?: string } | undefined
        if (head !== undefined && head.type === 'text') head.text = `${head.text ?? ''}\n\n${note}`.trim()
        else baseParts.unshift({ type: 'text', text: note })
      }
      if (fileParts.length > 0 || degraded.length > 0) promptInput = [...baseParts, ...fileParts]
    }
    let stream: ReplyStream | undefined
    let streamBroken = false
    let progressChain: Promise<void> = Promise.resolve()
    // 原生进度显示（T1.6）：caps.statusProgress 渠道在落定前把「思考中/工具执行」
    // 附在快照尾部同一条流式消息内；文本落定即清。
    let progressNote = ''
    const noteProgress = (note: string): void => {
      if (adapter.caps.statusProgress !== true) return
      progressNote = note
      pushProgress()
    }
    const snapshot = (): string =>
      progressNote === '' ? segments.join('\n\n') : [segments.join('\n\n'), progressNote].filter((s) => s !== '').join('\n\n')
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
    const pendingDeliverables: DeliverableRef[] = []
    let lastTurn: number | undefined
    const consume = (raw: unknown): void => {
      const event = raw as SessionEventLike
      if (typeof event?.data?.turn === 'number') lastTurn = event.data.turn
      if (event?.type === 'assistant/message') {
        const text = extractAssistantText(event)
        if (text !== '') {
          progressNote = ''
          segments.push(text)
          if (!streamBroken) pushProgress()
        }
      } else if (event?.type === 'deliverables/presented') {
        // 产物回传源（T2.4）：present 事件给工作区路径，收轮后再读字节送渠道。
        for (const ref of extractDeliverables(event)) pendingDeliverables.push(ref)
      } else if (event?.type === 'tool/call') {
        const toolName = String(event.data?.name ?? '工具')
        noteProgress(`🔧 正在执行：${toolName}`)
      } else if (event?.type === 'step/start') {
        if (segments.length === 0) noteProgress('🤔 思考中…')
      } else if (event?.type === 'turn/end' && endReason === undefined) {
        endReason = String(event.data?.reason?.kind ?? 'completed')
        markDone()
      }
    }
    try {
      // 事件面（0.3.8）：宿主 session/event 总线优先——desktop 线实证 @Remote
      // follow 流帧直调收不到事件（回合零事件 → 全部看门狗超时）；总线缺位回退 follow 旧路。
      unsubscribe =
        this.deps.eventTap !== undefined
          ? this.deps.eventTap.subscribe(sessionId, consume)
          : sessionApi.follow(sessionId, consume)
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
      await sessionApi.prompt(sessionId, promptInput)
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
      // 出站净化（0.4.5）：剥 genui（```dsh-ui）/ raw-html（裸 HTML）结构体，抽 SVG 图表。
      const sanitized = sanitizeImReply((snapshot() + suffix).trim())
      const finalText =
        sanitized.text !== ''
          ? sanitized.text
          : sanitized.svgBlocks.length > 0
            ? '（图表见附图）'
            : '本轮无可见输出。'
      const parts = splitText(finalText, adapter.caps.maxMessageLength ?? 0)
      const meta: DeliverMeta = { accountId, sessionId, turn: lastTurn }

      if (canStream && !streamBroken && stream !== undefined) {
        const receipt = await stream.finish(parts[0]).catch((error: Error) => {
          this.log.warn(`流式 finish 失败，降级补发: ${error.message}`)
          return undefined
        })
        if (receipt !== undefined) {
          this.noteUncertain(receipt, '流式收尾')
          this.recordDelivery(message, parts[0], receipt.uncertain ? 'uncertain' : 'delivered', meta)
        }
        if (receipt === undefined) {
          await this.deliverParts(adapter, message, parts, meta)
        } else {
          for (const extra of parts.slice(1)) await this.deliverOne(adapter, message, extra, meta)
        }
      } else {
        await this.deliverParts(adapter, message, parts, meta)
      }
      this.log.info(
        `回合完成：${message.address.channel}/${message.address.kind} turn=${lastTurn ?? '?'} 收轮=${endReason ?? '?'} 投递 ${finalText.length} 字`,
      )
      // 产物回传（T2.4）：正文投递完再送文件，缺面退文字清单。
      if (pendingDeliverables.length > 0) {
        await this.deliverablesToChannel(adapter, message, accountId, sessionId, pendingDeliverables)
      }
      // SVG 图表附图（0.4.5）：正文投递完再发图，渲染失败降级纯文字不阻断。
      if (sanitized.svgBlocks.length > 0) {
        await this.deliverSvgCharts(adapter, message, accountId, sessionId, sanitized.svgBlocks)
      }
      // Phase 8 relay：主通道投递完成后检查抄送绑定
      if (this.deps.relayStore !== undefined) {
        const relayBinding = this.deps.relayStore.get(sessionId)
        if (relayBinding !== undefined) {
          const notifyEntry = this.accounts.get(relayBinding.notifyAccountId)
          if (notifyEntry !== undefined && typeof notifyEntry.adapter.reply === 'function') {
            try {
              const relayText = `[${message.address.channel}/${shortId(sessionId)}] ${finalText}`
              // 通知渠道地址构造：dingtalk-notify 忽略 address；qq-notify 用 chatId 作 openid/group_openid
              const notifyAddress: ChatAddress = {
                channel: notifyEntry.adapter.id,
                kind: 'dm',
                chatId: relayBinding.targetId ?? sessionId,
              }
              const relayParts = splitText(relayText, notifyEntry.adapter.caps.maxMessageLength ?? 0)
              for (const part of relayParts) {
                const receipt = await notifyEntry.adapter.reply(notifyAddress, part)
                this.noteUncertain(receipt, 'relay 抄送')
              }
              this.log.info(`relay 抄送完成 → ${relayBinding.notifyAccountId}（${finalText.length} 字）`)
            } catch (error) {
              this.log.warn(`relay 抄送失败（${relayBinding.notifyAccountId}）: ${(error as Error).message}`)
            }
          } else {
            this.log.warn(`relay 通知账号 ${relayBinding.notifyAccountId} 适配器不在位，跳过抄送`)
          }
        }
      }
      // 超时迟到补投（T2.9）：本轮以 timeout 收轮——保留订阅直到真 turn/end，
      // 迟到结果一次性补投（dedupKey 防重复投递）。
      if (endReason === 'timeout') this.startLateHarvest(adapter, message, accountId, sessionId)
    } catch (error) {
      if (error instanceof UnsupportedError) {
        await adapter.reply(message.address, error.message)
        return
      }
      // 报错带参考号 + 根因链：createSession 失败（如有）一并落日志与回包，
      // 摆脱「只有参考号、本机日志无处可看」的排障死角（desktop 线实证）。
      const ref = `IMU-${Date.now().toString(36)}`
      const detail = error instanceof Error ? error.message : String(error)
      const root = this.lastEnsureFailure.get(chatKey(message.address))
      this.log.error(
        `runTurn 失败（${ref}）: ${detail}` + (root !== undefined ? `；此前 createSession 失败: ${root}` : ''),
      )
      await adapter.reply(
        message.address,
        `任务提交失败（参考号 ${ref}）：${detail.slice(0, 200)}` +
          (root !== undefined ? `\n（会话创建此前已失败：${root.slice(0, 160)}）` : '') +
          `\n详情见插件日志 plugin.log。`,
      )
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

  private async deliverParts(adapter: ChannelAdapter, message: SemanticMessage, parts: string[], meta?: DeliverMeta): Promise<void> {
    for (const part of parts) await this.deliverOne(adapter, message, part, meta)
  }

  private async deliverOne(adapter: ChannelAdapter, message: SemanticMessage, text: string, meta?: DeliverMeta): Promise<void> {
    try {
      const receipt = await adapter.reply(message.address, text)
      this.noteUncertain(receipt, adapter.id)
      this.recordDelivery(message, text, receipt.uncertain ? 'uncertain' : 'delivered', meta)
    } catch (error) {
      // 确定性失败入可补发集（≤3 次）；抛出给调用方保持原语义。
      this.recordDelivery(message, text, 'failed', { ...meta, error: 'send-error' })
      throw error
    }
  }

  /** 投递记录（T2.5）：未启用 deliveryLog 时零开销；failed 原文进内存 outbox。 */
  private recordDelivery(
    message: SemanticMessage,
    text: string,
    status: DeliveryStatus,
    opts?: DeliverMeta,
  ): void {
    const log = this.deps.deliveryLog
    if (log === undefined) return
    const rec = log.append({
      direction: 'out',
      accountId: opts?.accountId,
      channel: message.address.channel,
      kind: message.address.kind,
      chatId: message.address.chatId,
      sessionId: opts?.sessionId,
      turn: opts?.turn,
      status,
      summary: text,
      ...(opts?.dedupKey !== undefined ? { dedupKey: opts.dedupKey } : {}),
      ...(opts?.error !== undefined ? { error: opts.error } : {}),
    })
    if (status === 'failed') this.outbox.set(rec.seq, text)
  }

  /** /delivery retry：确定性失败且 <MAX_RETRY 才可补；uncertain 绝不补（D7）。 */
  async retryDelivery(seq: number): Promise<string> {
    const log = this.deps.deliveryLog
    if (log === undefined) return '投递日志未启用，无法补发。'
    const rec = log.get(seq)
    if (rec === undefined) return `未找到投递记录 #${seq}（7 天/1000 条窗口外）。`
    if (rec.status !== 'failed') return `#${seq} 当前状态 ${rec.status}；仅确定性失败可补发（D7）。`
    if (rec.attempts >= MAX_RETRY) return `#${seq} 已达补发上限（${MAX_RETRY} 次）。`
    const entry = rec.accountId !== undefined ? this.accounts.get(rec.accountId) : undefined
    if (entry === undefined) return `#${seq} 对应账号已注销/未在本机，无法补发。`
    if (rec.chatId === undefined) return `#${seq} 缺少目标聊天，无法补发。`
    const text = this.outbox.get(seq)
    if (text === undefined) return `#${seq} 原文不在本机内存（插件重启后仅存摘要），无法补发全文。`
    const address: ChatAddress = { channel: rec.channel, kind: rec.kind ?? 'dm', chatId: rec.chatId }
    try {
      const receipt = await entry.adapter.reply(address, text)
      const attempts = rec.attempts + 1
      if (receipt.uncertain) {
        log.mark(seq, { status: 'uncertain', attempts })
        return `#${seq} 补发结果不明，已停止后续补发（D7）。`
      }
      log.mark(seq, { status: 'delivered', attempts })
      return `#${seq} 补发成功。`
    } catch (error) {
      log.mark(seq, { attempts: rec.attempts + 1, error: 'send-error' })
      this.log.warn(`补发 #${seq} 失败: ${(error as Error).message}`)
      return `#${seq} 补发失败（已计数 ${rec.attempts + 1}/${MAX_RETRY}）。`
    }
  }

  /** SVG 图表附图（0.4.5）：渲染 PNG → 渠道图片消息；缺面/失败降级纯文字。 */
  private async deliverSvgCharts(
    adapter: ChannelAdapter,
    message: SemanticMessage,
    accountId: string,
    sessionId: string,
    blocks: string[],
  ): Promise<void> {
    if (adapter.caps.fileOut !== true || typeof adapter.sendFile !== 'function') {
      this.log.warn('本轮含 SVG 图表，但当前渠道不支持图片发送（已忽略附图）')
      return
    }
    for (const svg of blocks) {
      const image = await renderSvgToPng(svg)
      if (image === undefined) {
        this.log.warn('SVG 图表渲染失败（sharp 缺位或 SVG 语法错误），已跳过该附图')
        continue
      }
      try {
        const receipt = await adapter.sendFile(message.address, image)
        this.noteUncertain(receipt, 'SVG 附图')
        this.recordDelivery(message, `file:${image.name}`, receipt.uncertain ? 'uncertain' : 'delivered', {
          accountId,
          sessionId,
        })
      } catch (error) {
        this.log.warn(`SVG 附图发送失败: ${(error as Error).message}`)
      }
    }
  }

  /** 产物文件出站（T2.4 后半）：读面+fileOut 双在位才送文件，否则文字替代清单。 */
  private async deliverablesToChannel(
    adapter: ChannelAdapter,
    message: SemanticMessage,
    accountId: string,
    sessionId: string,
    refs: DeliverableRef[],
  ): Promise<void> {
    const compat = this.deps.deliverables
    const canSend = compat?.mode === 'workspace' && adapter.caps.fileOut === true && typeof adapter.sendFile === 'function'
    if (!canSend) {
      const note = fileOutUnavailableNote(refs.map((r) => ({ name: r.name })))
      if (note !== '') await adapter.reply(message.address, note)
      return
    }
    const workspace = this.workspaceOverrides.get(chatOverrideKey(message.address))
    for (const ref of refs) {
      const bytes = await compat!.read(sessionId, ref, workspace)
      if (bytes === undefined) {
        await adapter.reply(message.address, `产物「${ref.name}」读取失败，未回传（请在网页端查看）。`)
        continue
      }
      try {
        const receipt = await adapter.sendFile!(message.address, { name: bytes.name, data: bytes.data, mimeType: 'application/octet-stream' })
        this.noteUncertain(receipt, '产物回传')
        this.recordDelivery(message, `file:${bytes.name}`, receipt.uncertain ? 'uncertain' : 'delivered', { accountId, sessionId })
      } catch (error) {
        this.log.warn(`产物回传失败（${ref.name}）: ${(error as Error).message}`)
        await adapter.reply(message.address, `产物回传失败：${bytes.name}（请在网页端下载）`)
      }
    }
  }

  /** 超时后的迟到结果收割（T2.9，防重复投递：dedupKey+seen）。 */
  private startLateHarvest(adapter: ChannelAdapter, message: SemanticMessage, accountId: string, sessionId: string): void {
    const key = chatKey(message.address)
    this.lateFollows.get(key)?.dispose()
    const graceMs = this.deps.turnTimeoutMs ?? 10 * 60 * 1000
    const collected: string[] = []
    let disposed = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      if (this.lateFollows.get(key)?.dispose === dispose) this.lateFollows.delete(key)
      try {
        unsubscribe?.()
      } catch {
        // 退订失败留给宿主生命周期。
      }
    }
    try {
      unsubscribe = this.deps.sessionApi.follow(sessionId, (raw) => {
        const event = raw as SessionEventLike
        if (event?.type === 'assistant/message') {
          const text = extractAssistantText(event)
          if (text !== '') collected.push(text)
        } else if (event?.type === 'turn/end') {
          dispose()
          const text = collected.join('\n\n').trim()
          if (text !== '') void this.deliverLateResult(adapter, message, accountId, sessionId, text)
        }
      })
    } catch {
      return // follow 面缺位：无迟到收割，如实放弃不伪装。
    }
    timer = setTimeout(dispose, graceMs)
    this.lateFollows.set(key, { dispose })
  }

  private async deliverLateResult(
    adapter: ChannelAdapter,
    message: SemanticMessage,
    accountId: string,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const dedupKey = `${sessionId}:late`
    if (this.deps.deliveryLog?.seen(dedupKey) === true) return
    const parts = splitText(`📦 迟到的任务结果：\n\n${text}`, adapter.caps.maxMessageLength ?? 0)
    for (const part of parts) {
      try {
        await this.deliverOne(adapter, message, part, { accountId, sessionId, dedupKey })
      } catch {
        return
      }
    }
  }

  /** 碎片合并提交回调（index.ts 接线 FragmentBuffer.submit）：重建上下文走正常回合。 */
  submitFragment(key: string, text: string): void {
    const last = this.fragmentLast.get(key)
    if (last === undefined) return
    void this.handleInbound(last.accountId, { ...last.message, text })
  }

  /** /export：本聊天投递记录打 ZIP，渠道文件面可用则发送，缺位落盘导出目录。 */
  private async exportChat(address: ChatAddress, sessionId: string): Promise<string> {
    const log = this.deps.deliveryLog
    if (log === undefined) return '投递日志未启用，无内容可导出。'
    const rows = log.recent(500, { chatId: address.chatId, channel: address.channel })
    if (rows.length === 0) return '本聊天暂无投递记录可导出。'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `imu-export-${address.channel}-${address.chatId.replace(/[^\w-]/g, '_')}-${stamp}.zip`
    const json = JSON.stringify({ sessionId, exportedAt: new Date().toISOString(), records: rows }, null, 2)
    const bytes = zipSync([
      { name: 'deliveries.json', data: json },
      { name: 'README.txt', data: 'dsh-im-union 投递记录导出：仅摘要/状态/计数，零正文全文零凭据。\n' },
    ])
    // 适配器选择：按记录里的 accountId，缺退本聊天已登记账号（E3 同渠道歧义时取最近登记）。
    let adapter: ChannelAdapter | undefined
    for (const [accountId, entry] of this.accounts) {
      if (entry.adapter.id !== address.channel) continue
      adapter = entry.adapter
      if (rows[0]?.accountId === accountId) break
    }
    if (adapter !== undefined && adapter.caps.fileOut === true && typeof adapter.sendFile === 'function') {
      try {
        const receipt = await adapter.sendFile(address, { name: fileName, data: bytes, mimeType: 'application/zip' })
        this.noteUncertain(receipt, '导出投递')
        return `导出完成（${rows.length} 条）：${fileName}`
      } catch (error) {
        this.log.warn(`导出 sendFile 失败: ${(error as Error).message}`)
      }
    }
    if (this.deps.exportDir !== undefined) {
      mkdirSync(this.deps.exportDir, { recursive: true })
      const path = join(this.deps.exportDir, fileName)
      writeFileSync(path, bytes)
      return `渠道文件面不可用，ZIP 已写到本机：${path}`
    }
    return '渠道文件面不可用且未配置导出目录，导出中止。'
  }
}

/** 投递记录元信息（deliverOne/recordDelivery 透传）。 */
interface DeliverMeta {
  accountId?: string
  sessionId?: string
  turn?: number
  dedupKey?: string
  error?: string
}

/** 给渠道层用的地址构造便利函数。 */
export function addressOf(channel: string, kind: 'dm' | 'group', chatId: string, threadId?: string): ChatAddress {
  return { channel, kind, chatId, threadId }
}
