/**
 * 飞书渠道适配器（M1 P0，T1.3）。
 *
 * 依赖姿态：WS 长连接的握手/签名面是官方 SDK 私有协议（无公开文档可净室重写），
 * 按 spec 采 `@larksuiteoapi/node-sdk` 官方依赖 + 动态 import 懒加载（未配飞书
 * 账号不触包）。构造可注入 lark 面（测试 fake，不发真实请求）。
 *
 * 能力档位（首版，E1 纪律：声明=真实现，缺位=引擎降级）：
 * - 收发消息：im.message.receive_v1（WS 事件）+ im.message.create（REST）；
 * - 流式=逐步消息档（caps.editStream=false → 引擎收轮后分段 reply）。
 *   流式卡片档（cardkit 更新 API）依赖真机卡片环境验证，随渠道验收追加；
 * - 图片入站/文件/话题/按钮：P1+/T1.9 增强，本版本声明 false；
 * - QR 创建机器人（免手动去开发者后台建应用）：官方 device-code 流程接入中，
 *   当前用 credentials 绑定（appId/appSecret）。
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
  /** 注入官方 SDK 模块面（测试 fake；缺省动态 import）。 */
  lark?: LarkLike
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
  readonly caps: ChannelCaps = {
    editStream: false, // 首版逐步消息档：引擎收轮后分段 reply
    nativeStream: false,
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

  connected = false
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
      hint: '发送权限在首次收发消息时判定；若回复失败请查看开发者后台权限页',
    })
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
  return new FeishuAdapter({ appId, appSecret })
}
