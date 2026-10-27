/**
 * 飞书渠道适配器（M1 P0，T1.3）。
 *
 * 依赖姿态：WS 长连接的握手/签名面是官方 SDK 私有协议（无公开文档可净室重写），
 * 按 spec 采 `@larksuiteoapi/node-sdk` 官方依赖 + 动态 import 懒加载（未配飞书
 * 账号不触包）。构造可注入 lark 面（测试 fake，不发真实请求）。
 *
 * 能力档位（两档，E1 纪律：声明=真实现，缺位=引擎降级）：
 * - 收发消息：im.message.receive_v1（WS 事件）+ im.message.create（REST）；
 * - 流式两档（config.cardMode，默认 card）：
 *   card 档=流式卡片（公开 cardkit v1 REST：创建卡片实体→interactive 消息引用
 *   card_id→PUT 元素内容流式更新→收轮关 streaming_mode；需 cardkit:card:write
 *   权限，缺权时 beginStream 抛错→引擎自动退化文本档）；
 *   text 档=逐步消息（caps 全 false → 引擎收轮后分段 reply）；
 * - 文件收发（T2.4 渠道侧）：出站 im.v1.file.create（file_type=stream）+
 *   im.v1.message.create（msg_type=file, content.file_key）；入站 file 消息
 *   经 im.v1.message_resource 取回（GET /im/v1/messages/{id}/resources/{key}?type=file），
 *   需 im:resource 权限；限额不自设（引擎 FILE_BUDGET 20 MiB / ≤4 个，
 *   平台侧 stream 文件自身上限 30 MiB）；
 * - 语音（T3.5，**全配置驱动、默认关**）：config.voiceEnabled='true' 才接线——
 *   入站 msg_type=audio 帧下载资源（im.v1.message_resource）→ ffmpeg 转 wav/16k →
 *   DashScope ASR → 正文带 🎤 标记；任一环节失败回占位「[语音转写失败：原因类别]」
 *   不丢事件。出站 speak(address, text)（DashScope TTS → 转 opus → im.v1.file.create
 *   （file_type=opus，duration 毫秒）→ msg_type=audio）**已实现但不在 caps 上吹**：
 *   未真机实证前 caps.voice 保持 false（E1 纪律：声明=真实现），只作显式开启后的能力；
 *   DashScope key 只走凭据库 resolve（secrets.dashScopeKey），零明文入 config；
 *   ffmpeg/DashScope 均为外部进程与公开 REST，spawnImpl/fetchImpl 可注入替身；
 * - 图片入站/话题/按钮：P1+ 增强，本版本声明 false；
 * - QR 创建机器人：【决策不做】飞书官方无公开「扫码创建自建应用」API，
 *   OpenClaw 系流程为私有接口（净室边界 E2 同类红线）——保持 credentials 绑定
 *   + 开发者后台权限模板引导。
 *
 * 权限补全引导（D 面）：发消息命中平台权限错误码 → 转译为可读提示，
 * 不透传内部错误体。
 */
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  OutboundFile,
  Receipt,
  SemanticMessage,
} from './types.js'
import type { ChatAddress } from '../engine/router.js'
import {
  checkFfmpeg,
  dashscopeAsr,
  dashscopeTts,
  estimateWavDurationMs,
  transcode,
  voiceFailureText,
  type FetchLike,
  type SpawnLike,
  type VoiceFailure,
} from '../engine/voice.js'

const MAX_MESSAGE_LENGTH = 4000
const OPEN_BASE = 'https://open.feishu.cn'
const STREAM_ELEMENT_ID = 'imu_stream'
const CARD_UPDATE_THROTTLE_MS = 1_500

/**
 * 回合内「处理中」信号：飞书无 typing API（客户端不暴露），用**入站消息的表情回应**
 * 当状态位——实测 POST/DELETE /im/v1/messages/{id}/reactions 全链 code 0。
 * OnIt = 官方「需处理/进行中」语义；回复落地或超时即删，不污染历史。
 */
const TYPING_EMOJI = 'OnIt'
const TYPING_TTL_MS = 120_000

/**
 * 卡片按钮回传（审批确认）等待上限：与宿主审批红线 D5 的 5 分钟对齐。
 * 适配器自己必须定时：broker 的按钮分支是直接 `await askChoices(...)`，
 * 不挂它自己的超时——没人点又不能永久悬挂。
 */
const CHOICE_TIMEOUT_MS = 5 * 60 * 1000

/** 开发者后台「批量导入权限」模板（权限补全引导， diagnose 附送）。 */
export const FEISHU_PERMISSION_TEMPLATE = JSON.stringify({
  scopes: ['im:message', 'im:message:send_as_bot', 'im:chat', 'im:resource', 'cardkit:card:write'],
}, null, 2)

/** 无权限类平台错误码（发消息/读事件常见）。 */
const PERMISSION_ERROR_CODES = new Set([99991672, 2300024, 230027, 99991668])

/** 凭据类错误码：auth/v3/tenant_access_token 对 appId/appSecret 的直接裁决。 */
const CREDENTIAL_ERROR_CODES = new Set([10003, 10013, 10014])

/** 机器人能力未开通（bot/v3/info 回 11205，im 面回 232025）。 */
const BOT_ABILITY_MISSING_CODES = new Set([11205, 232025])

interface FeishuEventMessage {
  message_id?: string
  chat_id?: string
  chat_type?: string
  message_type?: string
  content?: string
}

interface FeishuEventPayload {
  sender?: { sender_id?: { user_id?: string; open_id?: string } }
  message?: FeishuEventMessage
}

/** 上传/下载面的响应形（只声明用到的字段）。 */
interface FeishuUploadResult {
  file_key?: string
  code?: number
  msg?: string
}

interface FeishuResourceResult {
  getReadableStream?: () => AsyncIterable<Uint8Array>
}

/** 卡片回传事件（card.action.trigger）归一后的形——SDK 长连接与 webhook 两形态共用。 */
export interface FeishuCardAction {
  messageId: string
  chatId: string
  operator: { openId?: string; userId?: string }
  action: { value?: Record<string, unknown> }
}

/**
 * 从 card.action.trigger 负载取关键字段。两种形态都要接：
 * - 长连接/webhook 原始体：`{schema:'2.0', header:{event_type}, event:{context, operator, action}}`；
 * - SDK 安全管道 normalize 后的形：`{messageId, chatId, operator:{openId}, action:{value}}`。
 * 缺关键字段回 undefined（调用方丢弃，不猜）。
 */
export function extractCardAction(payload: any): FeishuCardAction | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const nested = payload.event !== null && typeof payload.event === 'object' ? payload.event : payload
  const ctx = nested.context !== null && typeof nested.context === 'object' ? nested.context : {}
  const messageId =
    typeof nested.messageId === 'string' ? nested.messageId
      : typeof ctx.open_message_id === 'string' ? ctx.open_message_id
        : typeof nested.open_message_id === 'string' ? nested.open_message_id : undefined
  const chatId =
    typeof nested.chatId === 'string' ? nested.chatId
      : typeof ctx.open_chat_id === 'string' ? ctx.open_chat_id
        : typeof nested.open_chat_id === 'string' ? nested.open_chat_id : undefined
  if (messageId === undefined || chatId === undefined) return undefined
  const operator = (nested.operator ?? {}) as Record<string, unknown>
  const action = (nested.action ?? {}) as Record<string, unknown>
  const value = action.value !== null && typeof action.value === 'object' ? (action.value as Record<string, unknown>) : undefined
  return {
    messageId,
    chatId,
    operator: {
      ...(typeof operator.openId === 'string' ? { openId: operator.openId } : {}),
      ...(typeof operator.open_id === 'string' ? { openId: operator.open_id } : {}),
      ...(typeof operator.userId === 'string' ? { userId: operator.userId } : {}),
      ...(typeof operator.user_id === 'string' ? { userId: operator.user_id } : {}),
    },
    action: { ...(value === undefined ? {} : { value }) },
  }
}

/** 网络类错误判定（结果不明）——与确定性平台拒收分档。 */
function isNetworkLike(error: unknown): boolean {
  return error instanceof Error && /网络|timeout|timed out|unreachable|socket|ECONN|fetch/i.test(error.message)
}

export interface LarkLike {
  WSClient: new (options: { appId: string; appSecret: string }) => {
    start: (opts: { eventDispatcher: unknown }) => Promise<void> | void
  }
  EventDispatcher: new (options: Record<string, unknown>) => {
    register: (handlers: Record<string, (data: any) => unknown>) => unknown
  }
  Client: new (options: { appId: string; appSecret: string }) => {
    im: {
      message: {
        create: (payload: {
          params: { receive_id_type: string }
          data: { receive_id: string; msg_type: string; content: string }
        }) => Promise<{ message_id?: string; code?: number; msg?: string }>
      }
      /**
       * im.v1.file 上传面（官方 SDK 内部处理 multipart，返回顶层 file_key）。
       * 协议事实：file_type 可用 stream；单文件≤30 MB 且不得为空。
       * 宿主 SDK 缺位时 sendFile 明确抛（不静默）。
       */
      file?: {
        create: (payload: {
          data: { file_type: string; file_name: string; file: Uint8Array; duration?: number }
        }) => Promise<FeishuUploadResult | null | undefined>
      }
      /** im.v1.message_resource 下载面（图/音/视频/文件共用，type 区分）。 */
      messageResource?: {
        get: (payload: {
          params: { type: string }
          path: { message_id: string; file_key: string }
        }) => Promise<FeishuResourceResult>
      }
    }
    request: (opts: { method: string; url: string; data?: unknown; headers?: Record<string, unknown> }) => Promise<{
      code?: number
      msg?: string
      data?: { bot?: { open_id?: string } }
      tenant_access_token?: string
    }>
  }
  [key: string]: unknown
}

/** 语音档位（T3.5）：构造期由 config/凭据决定，运行期只读。 */
export interface FeishuVoiceOptions {
  enabled: true
  /** DashScope API Key（凭据库 resolve，绝不出现在日志/文案）。 */
  apiKey: string
  asrModel?: string
  ttsModel?: string
  ttsVoice?: string
  baseUrl?: string
  /** ffmpeg 注入替身（缺省懒 import node:child_process）。 */
  spawnImpl?: SpawnLike
  /** DashScope 注入替身（缺省全局 fetch）。 */
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export interface FeishuAdapterOptions {
  appId: string
  appSecret: string
  /** 流式档位：card=流式卡片（默认）/ text=逐步消息。 */
  cardMode?: 'card' | 'text'
  /** 语音档位开关（config.voiceEnabled='true' 才为 true；默认关）。 */
  voiceEnabled?: boolean
  /** 语音凭据与模型（voiceEnabled=false 时一律忽略）。 */
  voice?: Omit<FeishuVoiceOptions, 'enabled'>
  /** ffmpeg 注入替身（透传给 voice）。 */
  spawnImpl?: SpawnLike
  /** DashScope 注入替身（透传给 voice；与 cardkit 的 fetchImpl 各自独立路由）。 */
  voiceFetchImpl?: FetchLike
  /** 注入官方 SDK 模块面（测试 fake；缺省动态 import）。 */
  lark?: LarkLike
  /** card 档裸 REST 面与文件下载面共用（测试注入；缺省全局 fetch）。 */
  fetchImpl?: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{
    ok: boolean
    status: number
    json(): Promise<Record<string, any>>
    arrayBuffer?(): Promise<ArrayBuffer>
  }>
  logger?: (msg: string) => void
}

/**
 * im.message.receive_v1 → SemanticMessage。
 * p2p→dm / 其余→group；text 消息解 content JSON；mentions 占位符（@_user_1）剥离；
 * 非文本消息降级为占位文案（能力位未开的类型不丢事件）。
 */
export function normalizeFeishuMessage(payload: FeishuEventPayload): SemanticMessage | undefined {
  const message = payload?.message
  const sender = payload?.sender
  if (message?.chat_id === undefined || sender?.sender_id === undefined) return undefined
  const kind = message.chat_type === 'p2p' ? 'dm' : 'group'
  const userId = sender.sender_id.user_id ?? sender.sender_id.open_id
  if (userId === undefined) return undefined
  const address: ChatAddress = { channel: 'feishu', kind, chatId: message.chat_id }
  let text = ''
  let mentionedBot = false
  try {
    const parsed = JSON.parse(String(message.content ?? '{}')) as Record<string, unknown>
    if (message.message_type === 'text' || typeof parsed.text === 'string') {
      text = String(parsed.text ?? '')
      const mentions = parsed.mentions
      if (Array.isArray(mentions) && mentions.length > 0) {
        mentionedBot = true
        for (const mention of mentions) {
          const key = (mention as { key?: unknown })?.key
          if (typeof key === 'string') text = text.replace(key, '').trim()
        }
      }
    } else if (message.message_type === 'audio') {
      // 语音消息：正文先给占位（不丢事件）；开了语音档位时由 fillAudio 覆写为转写结果。
      // 不抢 'media'（视频）档：那种帧型本版本仍走「非文本未开通」占位，不造假。
      text = '[语音消息]'
      mentionedBot = true
    } else if (message.message_type === 'file' || typeof parsed.file_key === 'string') {
      // file 消息：正文先给文件名占位，字节由 fillFiles 异步补（失败也不丢整条）。
      const name = typeof parsed.file_name === 'string' && parsed.file_name !== '' ? parsed.file_name : '未命名文件'
      text = `[文件：${name}]`
      mentionedBot = true
    } else {
      text = `[非文本消息：${message.message_type ?? '未知'}，当前版本未开通该类型接收]`
      mentionedBot = true
    }
  } catch {
    text = String(message.content ?? '')
  }
  return {
    address,
    userId,
    text,
    mentionedBot,
    timestamp: Date.now(),
  }
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id = 'feishu'
  readonly label = '飞书'
  readonly caps: ChannelCaps

  connected = false
  private readonly cardMode: 'card' | 'text'
  private readonly fetchImpl: NonNullable<FeishuAdapterOptions['fetchImpl']>
  /** 语音档位（未开启=undefined：入站只留占位，零外部调用）。 */
  private readonly voice: FeishuVoiceOptions | undefined
  private tenantToken: { value: string; expireAtMs: number } | undefined
  /** chatId → 最近一条入站消息 id（typing 状态位挂在用户那条消息上）。 */
  private readonly lastInboundMessageId = new Map<string, string>()
  /** chatId → 在位「处理中」表情（回复落地/超时回收）。 */
  private readonly typingReactions = new Map<string, { messageId: string; reactionId: string }>()
  private listeners: MessageListener[] = []
  private client: InstanceType<LarkLike['Client']> | undefined
  private wsClient: { start: (opts: { eventDispatcher: unknown }) => Promise<void> | void } | undefined
  private lark: LarkLike | undefined
  private readonly log: (msg: string) => void
  /** 事件处理器表（测试注入口：直接驱动 receive handler）。 */
  handlers: Record<string, (data: any) => unknown> | undefined
  /**
   * 在位的选项卡：message_id → 待答。
   * 键用 message_id 而非 chatId：一个聊天可能先后出多张卡，旧卡迟到点击不得误判新卡。
   */
  private readonly pendingChoices = new Map<string, {
    labels: string[]
    ownerUserId: string | undefined
    resolve: (answer: string) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(private readonly options: FeishuAdapterOptions) {
    if (typeof options.appId !== 'string' || options.appId === '' || typeof options.appSecret !== 'string' || options.appSecret === '') {
      throw new Error('feishu: appId/appSecret 缺失（凭据库解析失败或未配置账号）')
    }
    this.log = options.logger ?? (() => {})
    this.lark = options.lark
    this.cardMode = options.cardMode === 'text' ? 'text' : 'card'
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: any }).fetch as any)
    // 语音档位：全配置驱动，默认关。开了但无 key 仍保留 enabled（诊断报 failed，
    // 入站回「未配置语音密钥」占位），不静默假装能力。
    if (options.voiceEnabled === true) {
      const base = options.voice ?? { apiKey: '' }
      this.voice = {
        enabled: true,
        apiKey: typeof base.apiKey === 'string' ? base.apiKey : '',
        ...(base.asrModel === undefined ? {} : { asrModel: base.asrModel }),
        ...(base.ttsModel === undefined ? {} : { ttsModel: base.ttsModel }),
        ...(base.ttsVoice === undefined ? {} : { ttsVoice: base.ttsVoice }),
        ...(base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl }),
        ...(base.timeoutMs === undefined ? {} : { timeoutMs: base.timeoutMs }),
        spawnImpl: base.spawnImpl ?? options.spawnImpl,
        fetchImpl: base.fetchImpl ?? options.voiceFetchImpl,
      }
    } else {
      this.voice = undefined
    }
    // E1 档位声明=实际模式：card 档原生流式；text 档全 false 让引擎分段。
    // voice 位**不因开了档位就抹上**：无真机实证保持 false（speak 已实现但不造假的声明）。
    this.caps = {
      editStream: false,
      nativeStream: this.cardMode === 'card',
      nativeChoices: true,
      // typing 落地=表情回应（无平台 typing API）；两者同源，故一起声明。
      statusReaction: true,
      typing: true,
      imageIn: false,
      fileIn: true,
      fileOut: true,
      threads: false,
      voice: false,
      maxMessageLength: MAX_MESSAGE_LENGTH,
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  private async requireLark(): Promise<LarkLike> {
    if (this.lark !== undefined) return this.lark
    const mod = (await import('@larksuiteoapi/node-sdk')) as unknown as LarkLike
    this.lark = mod
    return mod
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const lark = await this.requireLark()
    this.client = new lark.Client({ appId: this.options.appId, appSecret: this.options.appSecret })
    this.wsClient = new lark.WSClient({ appId: this.options.appId, appSecret: this.options.appSecret })
    this.handlers = {
      'im.message.receive_v1': async (data) => {
        const message = normalizeFeishuMessage(data)
        if (message === undefined) return
        // 「处理中」状态位锚点：后面 setTyping 用它给用户这条消息贴 OnIt。
        const inboundId = data?.message?.message_id
        if (typeof inboundId === 'string' && inboundId !== '') this.lastInboundMessageId.set(message.address.chatId, inboundId)
        // 入站文件下载（T2.4）：失败降级为无附件，不丢整条。
        await this.fillFiles(message, data?.message)
        // 入站语音转写（T3.5）：失败回占位文案，同样不丢整条。
        await this.fillAudio(message, data?.message)
        for (const listener of this.listeners) listener(message)
      },
      // 卡片按钮回传（审批确认）：长连接下飞书把 card.action.trigger 推同一条连接。
      'card.action.trigger': async (data) => this.handleCardAction(data),
    }
    const dispatcher = new lark.EventDispatcher({}).register(this.handlers)
    await this.wsClient.start({ eventDispatcher: dispatcher })
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.wsClient = undefined
    // 拆除即释放所有在位选项卡（空答=取消，fail-closed，不伪装批准）。
    for (const [, pending] of [...this.pendingChoices]) {
      clearTimeout(pending.timer)
      pending.resolve('')
    }
    this.pendingChoices.clear()
  }

  private async sendMessagePayload(address: ChatAddress, msgType: string, content: string): Promise<Receipt> {
    const client = this.client
    if (client === undefined || typeof client.im?.message?.create !== 'function') {
      throw new Error('feishu: 客户端未初始化（先 connect）')
    }
    try {
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: address.chatId,
          msg_type: msgType,
          content,
        },
      })
      if (typeof response?.code === 'number' && response.code !== 0) {
        throw this.translateApiError(response.code, response.msg)
      }
      return typeof response?.message_id === 'string'
        ? { platformMessageId: response.message_id, uncertain: false }
        : { uncertain: false }
    } catch (error) {
      if (error instanceof FeishuUncertainError) throw error
      if (isNetworkLike(error)) {
        throw new FeishuUncertainError(`feishu send: ${(error as Error).message}`)
      }
      throw error
    }
  }

  private async createMessage(address: ChatAddress, text: string): Promise<Receipt> {
    return this.sendMessagePayload(address, 'text', JSON.stringify({ text }))
  }

  /** 权限类错误码 → 可读引导（不透传内部错误体）。 */
  private translateApiError(code: number, msg?: string): Error {
    if (PERMISSION_ERROR_CODES.has(code)) {
      return new Error(`feishu: 应用权限不足（code ${code}）。请在飞书开发者后台为应用开通「获取与发送单聊、群组消息」（im:message）后重试。`)
    }
    return new Error(`feishu: 平台拒绝请求（code ${code}）`)
  }

  async reply(address: ChatAddress, text: string): Promise<Receipt> {
    // 回复即收轮：先回收「处理中」状态位（失败不影响投递）。
    void this.clearTyping(address)
    return this.createMessage(address, text)
  }

  /**
   * 回合开始「处理中」信号（引擎在 prompt 前调用）。飞书无 typing API，落地为
   * 给用户本条入站消息加 OnIt 表情；同一聊天只留一个，回复落地/2 分钟超时自清。
   * 任一环节失败一律静默——这是增强项，不得阻断回合。
   */
  async setTyping(address: ChatAddress): Promise<void> {
    const messageId = this.lastInboundMessageId.get(address.chatId)
    if (messageId === undefined) return
    await this.clearTyping(address)
    try {
      const data = await this.rest<{ reaction_id?: string }>('POST', `/open-apis/im/v1/messages/${messageId}/reactions`, {
        reaction_type: { emoji_type: TYPING_EMOJI },
      })
      const reactionId = data.reaction_id
      if (typeof reactionId !== 'string' || reactionId === '') return
      this.typingReactions.set(address.chatId, { messageId, reactionId })
      const timer = setTimeout(() => void this.clearTyping(address), TYPING_TTL_MS)
      timer.unref?.()
    } catch {
      // 表情权限缺位/限频：静默，不影响回合。
    }
  }

  /** 回收「处理中」表情（重复调用幂等）。 */
  private async clearTyping(address: ChatAddress): Promise<void> {
    const pending = this.typingReactions.get(address.chatId)
    if (pending === undefined) return
    this.typingReactions.delete(address.chatId)
    try {
      await this.rest('DELETE', `/open-apis/im/v1/messages/${pending.messageId}/reactions/${pending.reactionId}`)
    } catch {
      // 消息被撤回/表情已被手动移除：无需处理。
    }
  }

  /**
   * 审批/选项确认卡片（T1.9 按钮面）。
   * 协议事实（真机实测）：2.0 schema 的 `body.elements` 已不支持 `action` 标签
   * （230099 / 200861 unsupported tag action），按钮只能走 1.0 形态（顶层 elements）；
   * 内联 interactive 消息不碰 cardkit 实体面，因此不需要卡片实体权限。
   * multi=true 不接（卡片无多选原语）：抛错由 broker 回落文本菜单，不造假。
   */
  async askChoices(
    address: ChatAddress,
    question: string,
    options: readonly string[],
    multi: boolean,
    signal?: AbortSignal,
    opts?: { ownerUserId?: string },
  ): Promise<{ answer: string; uncertain: boolean }> {
    const client = this.client
    if (client === undefined) throw new Error('feishu: 客户端未初始化（先 connect）')
    if (multi) throw new Error('feishu: 多选无卡片原语（回落文本菜单）')
    const labels = options.map((option) => String(option)).filter((label) => label !== '')
    if (labels.length === 0) throw new Error('feishu: 选项为空')
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '需要确认' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: question } },
        {
          tag: 'action',
          actions: labels.map((label, index) => ({
            tag: 'button',
            text: { tag: 'plain_text', content: label },
            type: index === 0 ? 'primary' : 'default',
            value: { imu: 'choice', label },
          })),
        },
      ],
    }
    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: address.chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    })
    if (typeof response?.code === 'number' && response.code !== 0) throw this.translateApiError(response.code, response.msg)
    const messageId = typeof response?.message_id === 'string' ? response.message_id : undefined
    if (messageId === undefined) throw new Error('feishu: 交互卡片未返回 message_id')

    return new Promise<{ answer: string; uncertain: boolean }>((resolveOuter) => {
      let done = false
      const onAbort = (): void => settle('')
      const settle = (answer: string): void => {
        if (done) return
        done = true
        const held = this.pendingChoices.get(messageId)
        if (held !== undefined) {
          clearTimeout(held.timer)
          this.pendingChoices.delete(messageId)
        }
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        // 卡片已确定发出，后续任何结果（点/超时/取消/撤回）都是确定性的。
        resolveOuter({ answer, uncertain: false })
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          settle('')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => settle(''), CHOICE_TIMEOUT_MS)
      timer.unref?.()
      this.pendingChoices.set(messageId, {
        labels,
        ownerUserId: opts?.ownerUserId,
        resolve: settle,
        timer,
      })
    })
  }

  /**
   * 卡片按钮点击回传（card.action.trigger，长连接同一条通道）。
   * D5 纪律：只有发起者能定夺，他人点击不改判；超时/pending 已清则忽略。
   * 回包给 toast（飞书卡片回调响应），让用户看到「已记录」。
   */
  private async handleCardAction(payload: unknown): Promise<Record<string, unknown> | undefined> {
    const evt = extractCardAction(payload)
    if (evt === undefined) return undefined
    const pending = this.pendingChoices.get(evt.messageId)
    if (pending === undefined) return undefined
    const owner = pending.ownerUserId
    if (owner !== undefined && evt.operator.openId !== owner && evt.operator.userId !== owner) {
      return { toast: { type: 'info', content: '该请求只接受发起者的答复' } }
    }
    const raw = evt.action.value?.label
    const label = typeof raw === 'string' ? raw : ''
    if (!pending.labels.includes(label)) {
      return { toast: { type: 'error', content: '未能识别该按钮，请用文本回复' } }
    }
    pending.resolve(label)
    return { toast: { type: 'success', content: `已记录：${label}` } }
  }

  /**
   * 出站文件（T2.4）：im.v1.file.create（file_type=stream）→ im.v1.message.create
   * （msg_type=file, content.file_key）。限额：引擎 FILE_BUDGET 在上游已裁（20 MiB ≤ 4），
   * 本层只重平台硬约束（非空文件）。
   */
  async sendFile(address: ChatAddress, file: OutboundFile, _signal?: AbortSignal): Promise<Receipt> {
    const fileKey = await this.uploadFile('stream', file.name, file.data)
    return this.sendMessagePayload(address, 'file', JSON.stringify({ file_key: fileKey }))
  }

  /**
   * im.v1.file.create 上传面（普通文件与语音条共用）。协议事实：file_type 可用
   * stream / opus（opus 需 duration 毫秒，见飞书「上传文件」文档）；单文件 ≤30 MB
   * 且不得为空。错误分型沿用既有姿态：网络类=Uncertain（D7 禁自动重发），
   * 平台码=确定性转译。
   */
  private async uploadFile(fileType: string, fileName: string, data: Uint8Array, durationMs?: number): Promise<string> {
    const client = this.client
    if (client === undefined) throw new Error('feishu: 客户端未初始化（先 connect）')
    if (typeof client.im?.file?.create !== 'function') {
      throw new Error('feishu: 当前 SDK 面缺 im.file.create，文件上传不可用')
    }
    if (data.byteLength === 0) throw new Error(`feishu: 空文件不允许上传（${fileName}）`)
    let uploaded: FeishuUploadResult | null | undefined
    try {
      uploaded = await client.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: Buffer.from(data),
          ...(typeof durationMs === 'number' && durationMs > 0 ? { duration: Math.round(durationMs) } : {}),
        },
      })
    } catch (error) {
      if (isNetworkLike(error)) throw new FeishuUncertainError(`feishu file upload: ${(error as Error).message}`)
      const code = (error as { code?: unknown }).code
      if (typeof code === 'number') throw this.translateApiError(code, (error as Error).message)
      throw error
    }
    if (typeof uploaded?.code === 'number' && uploaded.code !== 0) {
      throw this.translateApiError(uploaded.code, uploaded.msg)
    }
    const fileKey = uploaded?.file_key
    if (typeof fileKey !== 'string' || fileKey === '') {
      throw new Error('feishu: 文件上传未返回 file_key')
    }
    return fileKey
  }

  /**
   * 入站文件字节（message_type=file）：走 im.v1.message_resource 下载面。
   * 失败只降级为无附件（正文已带文件名占位），不丢整条消息。
   */
  private async fillFiles(message: SemanticMessage, raw: FeishuEventMessage | undefined): Promise<void> {
    if (raw === undefined || raw.message_type !== 'file') return
    if (typeof raw.message_id !== 'string' || raw.message_id === '') return
    let fileKey = ''
    let fileName = '未命名文件'
    try {
      const parsed = JSON.parse(String(raw.content ?? '{}')) as Record<string, unknown>
      if (typeof parsed.file_key === 'string') fileKey = parsed.file_key
      if (typeof parsed.file_name === 'string' && parsed.file_name !== '') fileName = parsed.file_name
    } catch {
      return
    }
    if (fileKey === '') return
    const data = await this.downloadResource(raw.message_id, fileKey, 'file')
    if (data === undefined) return
    message.files = [{ name: fileName, data }]
  }

  /**
   * im.v1.message_resource 下载面（文件/语音等资源共用，type 区分）。
   * 无下载面/抛错/无流/空字节 → undefined（降级不抛，归一层已给占位正文）。
   */
  private async downloadResource(messageId: string, resourceKey: string, type: 'file' | 'media'): Promise<Uint8Array | undefined> {
    const client = this.client
    if (typeof client?.im?.messageResource?.get !== 'function') {
      this.log('feishu: 当前 SDK 面缺 im.message_resource.get，入站资源降级为无字节')
      return undefined
    }
    try {
      const resource = await client.im.messageResource.get({
        params: { type },
        path: { message_id: messageId, file_key: resourceKey },
      })
      const stream = resource?.getReadableStream?.()
      if (stream === undefined) return undefined
      const chunks: Uint8Array[] = []
      let total = 0
      for await (const chunk of stream) {
        const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk as ArrayLike<number>)
        chunks.push(bytes)
        total += bytes.byteLength
      }
      if (total === 0) return undefined
      const data = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.byteLength
      }
      return data
    } catch (error) {
      this.log(`feishu: 资源下载失败（type=${type}，降级）: ${(error as Error).message}`)
      return undefined
    }
  }

  /**
   * 入站语音转写（T3.5）：audio 帧 → 下载资源 → ffmpeg 转 wav/16k → DashScope ASR
   * → 正文覆写为「🎤 <转写>」。任一环节失败：正文回「[语音转写失败：<原因类别>]」，
   * 事件照常派发（不丢）。语音档位关闭时首行返回——零下载/零进程/零网络。
   */
  private async fillAudio(message: SemanticMessage, raw: FeishuEventMessage | undefined): Promise<void> {
    if (raw === undefined || raw.message_type !== 'audio') return
    const voice = this.voice
    if (voice === undefined) return
    const fail = (kind: VoiceFailure['kind'], note: string): void => {
      message.text = voiceFailureText({ kind, message: note, uncertain: false })
    }
    if (voice.apiKey === '') {
      fail('missing-config', 'feishu: 语音档位缺 DashScope API Key（凭据库未入库）')
      return
    }
    const messageId = typeof raw.message_id === 'string' ? raw.message_id : ''
    if (messageId === '') {
      fail('bad-input', 'feishu: audio 事件缺 message_id')
      return
    }
    let fileKey = ''
    try {
      const parsed = JSON.parse(String(raw.content ?? '{}')) as Record<string, unknown>
      if (typeof parsed.file_key === 'string') fileKey = parsed.file_key
    } catch {
      // content 非 JSON：按缺资源处理（下面 fileKey 为空即占位）
    }
    if (fileKey === '') {
      fail('bad-input', 'feishu: audio 帧 content 无 file_key')
      return
    }
    // 音频资源归属：飞书文档对语音下载 type=file / type=media 表述不一致 →
    // 先 file 再 media 双试（两次都无字节才判下载失败），不硬编单侧结论。
    let bytes = await this.downloadResource(messageId, fileKey, 'file')
    if (bytes === undefined) bytes = await this.downloadResource(messageId, fileKey, 'media')
    if (bytes === undefined || bytes.byteLength === 0) {
      fail('download-failed', 'feishu: 语音资源下载无字节')
      return
    }
    const converted = await transcode(bytes, 'ogg', 'wav', voice.spawnImpl, voice.timeoutMs === undefined ? {} : { timeoutMs: voice.timeoutMs })
    if (converted.audio === undefined) {
      message.text = voiceFailureText(converted.failure)
      return
    }
    const asr = await dashscopeAsr(converted.audio, {
      apiKey: voice.apiKey,
      format: converted.format ?? 'wav',
      ...(voice.asrModel === undefined ? {} : { model: voice.asrModel }),
      ...(voice.baseUrl === undefined ? {} : { baseUrl: voice.baseUrl }),
      ...(voice.timeoutMs === undefined ? {} : { timeoutMs: voice.timeoutMs }),
      ...(voice.fetchImpl === undefined ? {} : { fetchImpl: voice.fetchImpl }),
    })
    if (typeof asr.text !== 'string' || asr.text === '') {
      message.text = voiceFailureText(asr.failure)
      return
    }
    message.text = `🎤 ${asr.text}`
    this.log(`feishu: 语音转写完成（${String(asr.seconds ?? '?')}s）`)
  }

  /**
   * 出站语音（T3.5，**仅 voiceEnabled 可达**）：DashScope TTS → ffmpeg 转 opus/ogg
   * （飞书语音条口径 libopus/-ac 1/-ar 16000）→ im.v1.file.create（file_type=opus,
   * duration 毫秒）→ im.v1.message.create（msg_type=audio, content.file_key）。
   * caps.voice 仍为 false：未真机实证不吹能力位（E1）。
   */
  async speak(address: ChatAddress, text: string, _signal?: AbortSignal): Promise<Receipt> {
    const voice = this.voice
    if (voice === undefined) throw new Error('feishu: 语音档位未启用（config.voiceEnabled=true 才可发）')
    if (voice.apiKey === '') throw new Error('feishu: 语音档位缺 DashScope API Key（凭据库 feishu.<账号>.dashScopeKey 未入库）')
    const synth = await dashscopeTts(text, {
      apiKey: voice.apiKey,
      ...(voice.ttsModel === undefined ? {} : { model: voice.ttsModel }),
      ...(voice.ttsVoice === undefined ? {} : { voice: voice.ttsVoice }),
      ...(voice.baseUrl === undefined ? {} : { baseUrl: voice.baseUrl }),
      ...(voice.timeoutMs === undefined ? {} : { timeoutMs: voice.timeoutMs }),
      ...(voice.fetchImpl === undefined ? {} : { fetchImpl: voice.fetchImpl }),
    })
    if (synth.audio === undefined) {
      if (synth.failure?.uncertain === true) throw new FeishuUncertainError(`feishu speak: ${synth.failure.message}`)
      throw new Error(`feishu: 语音合成失败 ${voiceFailureText(synth.failure, '合成')}`)
    }
    const durationMs = estimateWavDurationMs(synth.audio)
    const encoded = await transcode(synth.audio, synth.format ?? 'wav', 'opus', voice.spawnImpl, voice.timeoutMs === undefined ? {} : { timeoutMs: voice.timeoutMs })
    if (encoded.audio === undefined) {
      if (encoded.failure?.uncertain === true) throw new FeishuUncertainError(`feishu speak: ${encoded.failure.message}`)
      throw new Error(`feishu: 语音转码失败 ${voiceFailureText(encoded.failure, '合成')}`)
    }
    const fileKey = await this.uploadFile('opus', `voice-${Date.now()}.opus`, encoded.audio, durationMs)
    return this.sendMessagePayload(
      address,
      'audio',
      JSON.stringify({ file_key: fileKey, ...(durationMs === undefined ? {} : { duration: Math.round(durationMs) }) }),
    )
  }

  // —— 流式卡片档（cardkit v1 公开 REST）————————————————

  /** tenant_access_token 自管（提前 60s 刷新；公开协议 auth/v3/internal）。 */
  private async token(): Promise<string> {
    if (this.tenantToken !== undefined && this.tenantToken.expireAtMs - 60_000 > Date.now()) {
      return this.tenantToken.value
    }
    const response = await this.fetchImpl(`${OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }),
    })
    const json = await response.json()
    if (!response.ok || typeof json.tenant_access_token !== 'string') {
      throw new Error(`feishu: tenant token 获取失败（code ${String(json.code)}）`)
    }
    this.tenantToken = { value: json.tenant_access_token, expireAtMs: Date.now() + Number(json.expire ?? 3600) * 1000 }
    return this.tenantToken.value
  }

  /** 通用 REST（带 tenant token）：「处理中」表情等非卡片面共用。 */
  private async rest<T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.token()
    const response = await this.fetchImpl(`${OPEN_BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = await response.json()
    if (!response.ok || (typeof json.code === 'number' && json.code !== 0)) {
      const code = Number(json.code ?? response.status)
      throw new Error(`feishu: 请求失败（code ${code}：${String(json.msg ?? '')}）`)
    }
    return (json.data ?? {}) as T
  }

  private async cardApi<T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.token()
    const response = await this.fetchImpl(`${OPEN_BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = await response.json()
    if (!response.ok || (typeof json.code === 'number' && json.code !== 0)) {
      const code = Number(json.code ?? response.status)
      if (PERMISSION_ERROR_CODES.has(code) || code === 99991672) {
        throw new Error(`feishu: 卡片权限不足（code ${code}），需 cardkit:card:write；开发者后台批量导入模板：${FEISHU_PERMISSION_TEMPLATE}`)
      }
      throw new Error(`feishu: cardkit 请求失败（code ${code}：${String(json.msg ?? '')}）`)
    }
    return (json.data ?? {}) as T
  }

  /** 开流：建卡片实体（streaming_mode 开）→ interactive 消息引用 card_id。 */
  async beginStream(address: ChatAddress): Promise<import('./types.js').ReplyStream> {
    if (this.cardMode !== 'card') throw new Error('feishu: 当前为逐步消息档（cardMode=text）')
    const self = this // 返回对象方法内 this 指向 stream 本体，必须外提
    const cardJson = {
      schema: '2.0',
      settings: { streaming_mode: true },
      header: { title: { tag: 'plain_text', content: 'AI 回复' } },
      body: { elements: [{ tag: 'markdown', content: '…', element_id: STREAM_ELEMENT_ID }] },
    }
    const created = await this.cardApi<{ card_id?: string }>('POST', '/open-apis/cardkit/v1/cards', {
      type: 'card_json',
      data: JSON.stringify(cardJson),
    })
    const cardId = created.card_id
    if (cardId === undefined) throw new Error('feishu: 卡片实体创建未返回 card_id')
    const sent = await this.createCardMessage(address, cardId)
    let lastSentAt = 0
    let pending: Promise<void> = Promise.resolve()
    let aborted = false
    const update = (content: string, throttle: boolean): Promise<void> => {
      pending = pending.then(async () => {
        if (aborted) return
        if (throttle) {
          const wait = CARD_UPDATE_THROTTLE_MS - (Date.now() - lastSentAt)
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        }
        lastSentAt = Date.now()
        // 全量口径：每次传完整内容，cardkit 自动做增量打字机渲染。
        await self.cardApi('PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/${STREAM_ELEMENT_ID}/content`, { content })
      })
      return pending
    }
    return {
      async update(markdown: string): Promise<void> {
        await update(markdown, true)
      },
      async finish(markdown: string): Promise<Receipt> {
        await update(markdown, false)
        // 收轮关流式模式（失败不阻断：卡片内容已落定）。
        await self.cardApi('PATCH', `/open-apis/cardkit/v1/cards/${cardId}/settings`, {
          config: { streaming_mode: false },
        }).catch((error: Error) => self.log(`feishu: 关闭流式模式失败：${error.message}`))
        // 卡片已落定 = 回合可见结果到位，「处理中」表情该收了。
        await self.clearTyping(address)
        return { platformMessageId: sent, uncertain: false }
      },
      abort(): void {
        aborted = true
      },
    }
  }

  private async createCardMessage(address: ChatAddress, cardId: string): Promise<string | undefined> {
    const client = this.client
    if (client === undefined) throw new Error('feishu: 客户端未初始化（先 connect）')
    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: address.chatId, msg_type: 'interactive', content: JSON.stringify({ card_id: cardId }) },
    })
    if (typeof response?.code === 'number' && response.code !== 0) throw this.translateApiError(response.code, response.msg)
    return typeof response?.message_id === 'string' ? response.message_id : undefined
  }

  authorize(): boolean | undefined {
    return undefined
  }

  async diagnose(): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    checks.push(await this.credentialsCheck())
    checks.push({
      name: 'ws-long-connection',
      status: this.connected ? 'passed' : 'unverified',
      // 长连接只证明握手成功：事件真投递还需机器人能力 + receive_v1 订阅。
      hint: this.connected ? '长连接已建立（不能据此推定机器人能力/消息权限已开通）' : '未连接',
    })
    checks.push(await this.botAbilityCheck())
    checks.push({
      name: 'permission-im-message',
      status: 'unverified',
      hint: '发送权限在首次收发消息时判定；批量导入模板：' + FEISHU_PERMISSION_TEMPLATE,
    })
    if (this.cardMode === 'card') {
      checks.push({
        name: 'permission-cardkit',
        status: 'unverified',
        hint: '流式卡片档需 cardkit:card:write（开通后须发布版本生效）；缺权时自动退化逐步消息档不丢回复',
      })
    }
    checks.push({
      name: 'permission-file',
      status: 'unverified',
      hint: '文件收发需 im:resource（上传 im.v1.file / 下载 im.v1.message_resource）；首次文件收发时实证',
    })
    checks.push(await this.voiceCheck())
    return checks
  }

  /**
   * 凭据探测：auth/v3/tenant_access_token 换 token（唯一对 appSecret 做真裁决的面）。
   * 曾探 `/open-apis/bot/v2/info`——该路径不存在（服务端 404 纯文本、SDK 直接抛），
   * 任何凭据都落「凭据或网络无效」；且 bot 面本身不校验 secret（错 secret 同样回
   * 11205），探它只能验能力不能验凭据——故拆成凭据位与机器人能力位两条。
   */
  private async credentialsCheck(): Promise<ChannelDiagnosisCheck> {
    const client = this.client
    if (client === undefined) return { name: 'credentials-valid', status: 'failed', hint: '未连接：先连接后再检查' }
    try {
      const response = await client.request({
        method: 'POST',
        url: '/open-apis/auth/v3/tenant_access_token/internal',
        data: { app_id: this.options.appId, app_secret: this.options.appSecret },
      })
      const code = response?.code
      if (code === undefined || code === 0) {
        return typeof response?.tenant_access_token === 'string'
          ? { name: 'credentials-valid', status: 'passed' }
          : { name: 'credentials-valid', status: 'unverified', hint: 'code 0 但未回 tenant_access_token' }
      }
      return {
        name: 'credentials-valid',
        status: 'failed',
        hint: CREDENTIAL_ERROR_CODES.has(code)
          ? `appId/appSecret 无效（code ${code}）：核对凭据库条目`
          : `凭据探测被拒（code ${code}）`,
      }
    } catch (error) {
      // 只取 message（不透传 error 体：axios config 里带着 Authorization/body）。
      const message = (error as Error)?.message ?? String(error)
      return {
        name: 'credentials-valid',
        status: 'failed',
        hint: isNetworkLike(error) ? `网络不可达：${message}` : `凭据探测失败：${message}`,
      }
    }
  }

  /**
   * 机器人能力探测：GET /open-apis/bot/v3/info（有 bot → code 0；无 bot → 11205）。
   * 这是「长连接通了却收不到消息」的判定位：无机器人能力时事件不投递、消息发不出。
   */
  private async botAbilityCheck(): Promise<ChannelDiagnosisCheck> {
    const client = this.client
    if (client === undefined) return { name: 'bot-ability', status: 'unverified', hint: '未连接：先连接后再检查' }
    try {
      const response = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
      const code = response?.code
      if (code === undefined || code === 0) {
        return { name: 'bot-ability', status: 'passed', hint: '机器人能力已开通；收发消息仍受 im:message 权限约束' }
      }
      if (BOT_ABILITY_MISSING_CODES.has(code)) {
        return {
          name: 'bot-ability',
          status: 'failed',
          hint: '应用未开通「机器人」能力（code 11205）：开发者后台「添加应用能力 → 机器人」并发布版本，否则长连接通也收不到消息事件、发不出消息',
        }
      }
      return { name: 'bot-ability', status: 'failed', hint: `机器人能力探测被拒（code ${code}）` }
    } catch (error) {
      const message = (error as Error)?.message ?? String(error)
      return { name: 'bot-ability', status: 'unverified', hint: `机器人能力探测未完成：${message}` }
    }
  }

  /**
   * 语音档位诊断（T3.5 三态）：
   * - 未启用（voiceEnabled 非 'true'）= unverified——能力存在但未开通，不谎报；
   * - 已启用但无密钥 / ffmpeg 探测失败 = failed（给可行动提示，不回显密钥）；
   * - 已启用 + 密钥到位 + ffmpeg 探测通过 = passed（DashScope 实调用仍需首次实证）。
   * 未注入探测面时不真起进程（禁真实副作用），诚实报 unverified。
   */
  private async voiceCheck(): Promise<ChannelDiagnosisCheck> {
    const voice = this.voice
    if (voice === undefined) {
      return {
        name: 'voice-pipeline',
        status: 'unverified',
        hint: '语音档位未启用（config.voiceEnabled=true + 凭据库 feishu.<账号>.dashScopeKey 入库后开启）；未真机实证前 caps.voice 保持 false',
      }
    }
    if (voice.apiKey === '') {
      return { name: 'voice-pipeline', status: 'failed', hint: '语音档位已开但 DashScope API Key 未入库（凭据库 feishu.<账号>.dashScopeKey）' }
    }
    if (voice.spawnImpl === undefined) {
      return { name: 'voice-pipeline', status: 'unverified', hint: '语音档位已配（密钥到位）；ffmpeg 探测面未注入，首次真实转码时实证' }
    }
    const probe = await checkFfmpeg({ spawnImpl: voice.spawnImpl, ...(voice.timeoutMs === undefined ? {} : { timeoutMs: voice.timeoutMs }) })
    return probe.ok
      ? { name: 'voice-pipeline', status: 'passed', hint: `ffmpeg 到位（${String(probe.version ?? '')}）；ASR/TTS 需首次实调用实证权限与配额` }
      : { name: 'voice-pipeline', status: 'failed', hint: `语音探测失败：${voiceFailureText(probe.failure)}（内部：${String(probe.failure?.message ?? '')}）` }
  }

  /** 测试/诊断驱动：模拟一条事件（与 SDK handler 同一入口）；回传 handler 的响应体。 */
  async injectEvent(eventName: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers?.[eventName]
    if (handler === undefined) throw new Error(`feishu: 未注册事件 ${eventName}`)
    return await handler(payload)
  }
}

class FeishuUncertainError extends Error {}

/**
 * 工厂挂 registry（懒加载动态 import SDK 面）。语音档位全配置驱动、默认关：
 * config.voiceEnabled='true' 才接线；API Key 只从凭据库 resolve（secrets.dashScopeKey，
 * meta.ts feishu 条目 secret 字段），零明文入 config；模型/音色走 config 可选项。
 */
export async function createFeishuAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): Promise<FeishuAdapter> {
  const appId = options.secrets.appId
  const appSecret = options.secrets.appSecret
  if (typeof appId !== 'string' || appId === '' || typeof appSecret !== 'string' || appSecret === '') {
    throw new Error(`feishu 账号 ${options.accountId}: appId/appSecret 未入库（检查凭据配置）`)
  }
  const config = options.config ?? {}
  const plain = (key: string): string | undefined => {
    const value = config[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const optional: Record<string, string> = {}
  const asrModel = plain('dashscopeModel')
  const ttsModel = plain('dashscopeTtsModel')
  const ttsVoice = plain('dashscopeVoice')
  const baseUrl = plain('dashscopeBaseUrl')
  if (asrModel !== undefined) optional.asrModel = asrModel
  if (ttsModel !== undefined) optional.ttsModel = ttsModel
  if (ttsVoice !== undefined) optional.ttsVoice = ttsVoice
  if (baseUrl !== undefined) optional.baseUrl = baseUrl
  return new FeishuAdapter({
    appId,
    appSecret,
    ...(config.cardMode === 'text' ? { cardMode: 'text' as const } : {}),
    ...(config.voiceEnabled === 'true'
      ? {
          voiceEnabled: true as const,
          voice: {
            apiKey: typeof options.secrets.dashScopeKey === 'string' ? options.secrets.dashScopeKey : '',
            ...optional,
          },
        }
      : {}),
  })
}
