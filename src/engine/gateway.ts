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
import { join } from 'node:path'
import type { CordisLike, LoggerLike } from '../types.js'
import type { UnionCapabilities } from '../host-compat/services.js'
import type { SessionApi } from '../host-compat/session-api.js'
import { UnsupportedError } from '../host-compat/session-api.js'
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
import type { ApprovalOutcome, ApprovalRequest, QuestionAnswer, QuestionRequest } from '../host-compat/interaction.js'
import type { ChannelAdapter, Receipt, ReplyStream, SemanticMessage } from '../channels/types.js'

export interface AccountSessionPrefs {
  /** 会话工作目录（宿主 session.create 的 cwd，直接决定 Agent 的项目目录）。 */
  cwd?: string
  /** Agent 预设 id（session.create 的 agentPreset）。 */
  agentPreset?: string
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface AccountPolicy {
  /** 私聊白名单 userId 集合；空集合=拒绝所有私聊（扫码自动入表由渠道层维护）。 */
  dmAllowlist: Set<string>
  /** 群聊总开关（默认开，触发仍需 @）。 */
  groupEnabled: boolean
  /** 私聊准入档位：approved=仅白名单（默认拒绝红线默认值）；all=接受所有私聊（用户显式开启）。 */
  privateAccess: 'approved' | 'all'
  /** 账号级会话偏好：仅在该账号**新建**会话时生效，已有会话不受影响。 */
  session?: AccountSessionPrefs
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
  /** 静音聊天（/mute，T2.8）：admitted 后、命令前静默丢弃。 */
  private muted = new Set<string>()
  /** /goal 目标备忘（chatKey → 文本，IM 侧存储不碰宿主）。 */
  private goals = new Map<string, string>()
  /** 拒绝提示冷却键（账号+用户 / 账号+群）：窗口内只提示一次，防回复风暴。 */
  private rejectionNotices = new Set<string>()
  /** 投递 seq → 原文全文（/delivery retry 补发用；重启即清，摘要在盘）。 */
  private outbox = new Map<number, string>()
  /** 碎片合并的上一次私聊消息上下文（submit 回调重建 SemanticMessage）。 */
  private fragmentLast = new Map<string, { accountId: string; message: SemanticMessage }>()
  /** 超时后的迟到结果订阅（T2.9，每聊天一个，新回合覆盖旧的）。 */
  private lateFollows = new Map<string, { dispose: () => void }>()
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
        privateAccess: policy?.privateAccess === 'all' ? 'all' : 'approved',
        ...(policy?.session !== undefined ? { session: policy.session } : {}),
      },
    })
    adapter.onMessage((message) => void this.handleInbound(accountId, message))
  }

  /** 凭据无关的编辑（别名/白名单/准入档位/会话偏好）原位同步策略，不重建适配器。 */
  updatePolicy(accountId: string, policy: Partial<AccountPolicy>): void {
    const entry = this.accounts.get(accountId)
    if (entry === undefined) return
    entry.policy = {
      dmAllowlist: new Set(policy.dmAllowlist ?? entry.policy.dmAllowlist),
      groupEnabled: policy.groupEnabled ?? entry.policy.groupEnabled,
      privateAccess: policy.privateAccess === 'all' || policy.privateAccess === 'approved'
        ? policy.privateAccess
        : entry.policy.privateAccess,
      session: policy.session !== undefined ? policy.session : entry.policy.session,
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
      // 命令在静音判定之前：静音期必须还能 /mute 解除（否则永久静默）。
      // resolve 对未绑定聊天登记的隐式绑定与 runTurn 惰性解析同值，无额外副作用。
      const sessionId = this.deps.router.resolve(message.address).sessionId
      const reply = await runCommand(this.commandDeps(), message.address, sessionId, command)
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

  private commandDeps(): CommandDeps {
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
    }
  }

  /**
   * 隐式 imu: 形 id → 宿主真会话 id：首次使用时 createSession 并绑定；
   * 失败则继续用隐式 id（老线/降级面下 follow/prompt 自有报错路径，不阻断命令面）。
   * 账号级会话偏好（cwd/预设/模型）只在这一刻应用——新会话生效，存量会话不动。
   */
  private async ensureSessionId(address: ChatAddress, binding: Binding, accountId: string, title?: string): Promise<string> {
    const { sessionApi, router } = this.deps
    if (sessionApi.backend !== 'native' || !binding.sessionId.startsWith('imu:')) return binding.sessionId
    const prefs = this.accounts.get(accountId)?.policy.session
    try {
      const workspace = this.workspaceOverrides.get(chatOverrideKey(address))
      const info = await sessionApi.createSession({
        sessionIdHint: binding.sessionId,
        ...(workspace !== undefined ? { workspace } : {}),
        ...(prefs?.cwd !== undefined && prefs.cwd !== '' && workspace === undefined ? { cwd: prefs.cwd } : {}),
        ...(prefs?.agentPreset !== undefined && prefs.agentPreset !== '' ? { preset: prefs.agentPreset } : {}),
        ...(prefs?.model !== undefined && prefs.model !== ''
          ? { model: prefs.model, ...(prefs.provider !== undefined && prefs.provider !== '' ? { provider: prefs.provider } : {}), ...(prefs.reasoningEffort !== undefined && prefs.reasoningEffort !== '' ? { reasoningEffort: prefs.reasoningEffort } : {}) }
          : {}),
        ...(title !== undefined && title !== '' ? { title } : {}),
      })
      router.bind(address, info.id)
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
      this.log.warn(`createSession 失败，继续使用隐式 id: ${(error as Error).message}`)
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
    const promptText = withQuoteContext(message.text, message.quoteText)
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
    try {
      unsubscribe = sessionApi.follow(sessionId, (raw) => {
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
      const finalText = (snapshot() + suffix).trim() === '' ? '本轮无可见输出。' : (snapshot() + suffix).trim()
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
      // 产物回传（T2.4）：正文投递完再送文件，缺面退文字清单。
      if (pendingDeliverables.length > 0) {
        await this.deliverablesToChannel(adapter, message, accountId, sessionId, pendingDeliverables)
      }
      // 超时迟到补投（T2.9）：本轮以 timeout 收轮——保留订阅直到真 turn/end，
      // 迟到结果一次性补投（dedupKey 防重复投递）。
      if (endReason === 'timeout') this.startLateHarvest(adapter, message, accountId, sessionId)
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
