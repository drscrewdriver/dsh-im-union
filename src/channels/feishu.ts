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
 * - 图片入站/文件/话题/按钮：P1+ 增强，本版本声明 false；
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
  Receipt,
  SemanticMessage,
} from './types.js'
import type { ChatAddress } from '../engine/router.js'

const MAX_MESSAGE_LENGTH = 4000
const OPEN_BASE = 'https://open.feishu.cn'
const STREAM_ELEMENT_ID = 'imu_stream'
const CARD_UPDATE_THROTTLE_MS = 1_500

/** 开发者后台「批量导入权限」模板（权限补全引导， diagnose 附送）。 */
export const FEISHU_PERMISSION_TEMPLATE = JSON.stringify({
  scopes: ['im:message', 'im:message:send_as_bot', 'im:chat', 'im:resource', 'cardkit:card:write'],
}, null, 2)

/** 无权限类平台错误码（发消息/读事件常见）。 */
const PERMISSION_ERROR_CODES = new Set([99991672, 2300024, 230027, 99991668])

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

export interface LarkLike {
  WSClient: new (options: { appId: string; appSecret: string }) => {
    start: (opts: { eventDispatcher: unknown }) => Promise<void> | void
  }
  EventDispatcher: new (options: Record<string, unknown>) => {
    register: (handlers: Record<string, (data: FeishuEventPayload) => Promise<void> | void>) => unknown
  }
  Client: new (options: { appId: string; appSecret: string }) => {
    im: {
      message: {
        create: (payload: {
          params: { receive_id_type: string }
          data: { receive_id: string; msg_type: string; content: string }
        }) => Promise<{ message_id?: string; code?: number; msg?: string }>
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

export interface FeishuAdapterOptions {
  appId: string
  appSecret: string
  /** 流式档位：card=流式卡片（默认）/ text=逐步消息。 */
  cardMode?: 'card' | 'text'
  /** 注入官方 SDK 模块面（测试 fake；缺省动态 import）。 */
  lark?: LarkLike
  /** card 档裸 REST 面（测试注入；缺省全局 fetch）。 */
  fetchImpl?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
    ok: boolean
    status: number
    json(): Promise<Record<string, any>>
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
  private tenantToken: { value: string; expireAtMs: number } | undefined
  private listeners: MessageListener[] = []
  private client: InstanceType<LarkLike['Client']> | undefined
  private wsClient: { start: (opts: { eventDispatcher: unknown }) => Promise<void> | void } | undefined
  private lark: LarkLike | undefined
  private readonly log: (msg: string) => void
  /** 事件处理器表（测试注入口：直接驱动 receive handler）。 */
  handlers: Record<string, (data: FeishuEventPayload) => Promise<void> | void> | undefined

  constructor(private readonly options: FeishuAdapterOptions) {
    if (typeof options.appId !== 'string' || options.appId === '' || typeof options.appSecret !== 'string' || options.appSecret === '') {
      throw new Error('feishu: appId/appSecret 缺失（凭据库解析失败或未配置账号）')
    }
    this.log = options.logger ?? (() => {})
    this.lark = options.lark
    this.cardMode = options.cardMode === 'text' ? 'text' : 'card'
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: any }).fetch as any)
    // E1 档位声明=实际模式：card 档原生流式；text 档全 false 让引擎分段。
    this.caps = {
      editStream: false,
      nativeStream: this.cardMode === 'card',
      nativeChoices: false,
      statusReaction: false,
      typing: false,
      imageIn: false,
      fileIn: false,
      fileOut: false,
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
        for (const listener of this.listeners) listener(message)
      },
    }
    const dispatcher = new lark.EventDispatcher({}).register(this.handlers)
    await this.wsClient.start({ eventDispatcher: dispatcher })
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.wsClient = undefined
  }

  private async createMessage(address: ChatAddress, text: string): Promise<Receipt> {
    const client = this.client
    if (client === undefined || typeof client.im?.message?.create !== 'function') {
      throw new Error('feishu: 客户端未初始化（先 connect）')
    }
    try {
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: address.chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
      if (typeof response?.code === 'number' && response.code !== 0) {
        throw this.translateApiError(response.code, response.msg)
      }
      return typeof response?.message_id === 'string'
        ? { platformMessageId: response.message_id, uncertain: false }
        : { uncertain: false }
    } catch (error) {
      if (error instanceof Error && /网络|timeout|unreachable/i.test(error.message)) {
        throw new FeishuUncertainError(`feishu send: ${(error as Error).message}`)
      }
      throw error
    }
  }

  /** 权限类错误码 → 可读引导（不透传内部错误体）。 */
  private translateApiError(code: number, msg?: string): Error {
    if (PERMISSION_ERROR_CODES.has(code)) {
      return new Error(`feishu: 应用权限不足（code ${code}）。请在飞书开发者后台为应用开通「获取与发送单聊、群组消息」（im:message）后重试。`)
    }
    return new Error(`feishu: 平台拒绝请求（code ${code}）`)
  }

  async reply(address: ChatAddress, text: string): Promise<Receipt> {
    return this.createMessage(address, text)
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
    try {
      if (this.client === undefined) throw new Error('未连接')
      const response = await this.client.request({ method: 'GET', url: '/open-apis/bot/v2/info' })
      const ok = response?.code === undefined || response.code === 0
      checks.push({ name: 'credentials-valid', status: ok ? 'passed' : 'failed', hint: ok ? undefined : `code ${response?.code}` })
    } catch (error) {
      checks.push({ name: 'credentials-valid', status: 'failed', hint: '凭据或网络无效，请检查 appId/appSecret' })
    }
    checks.push({
      name: 'ws-long-connection',
      status: this.connected ? 'passed' : 'unverified',
      hint: this.connected ? undefined : '未连接',
    })
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
    return checks
  }

  /** 测试/诊断驱动：模拟一条 receive 事件（与 SDK handler 同一入口）。 */
  async injectEvent(eventName: string, payload: FeishuEventPayload): Promise<void> {
    const handler = this.handlers?.[eventName]
    if (handler === undefined) throw new Error(`feishu: 未注册事件 ${eventName}`)
    await handler(payload)
  }
}

class FeishuUncertainError extends Error {}

/** 工厂挂 registry（懒加载动态 import SDK 面）。 */
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
  return new FeishuAdapter({
    appId,
    appSecret,
    ...(options.config.cardMode === 'text' ? { cardMode: 'text' as const } : {}),
  })
}
