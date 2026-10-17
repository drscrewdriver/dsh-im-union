/**
 * 企业微信「自建应用」渠道适配器（M2，T3.4：HTTP 回调 + 加解密 + 微信插件路径）。
 *
 * 与 wecom.ts（智能机器人长连接模式）同平台但两适配器独立并存：本节是
 * 自建应用「接收消息服务器 API」模式——企微服务器把消息 POST 到开发者
 * 公网 URL，出站走 access_token + message/send REST 面。
 *
 * 协议事实（腾讯企业微信官方公开协议，净室口径独立重实现，不引任何 SDK）：
 * - 回调 URL 验证：GET query {msg_signature, timestamp, nonce, echostr}；
 *   验签 = SHA1(字典序 sort(token, timestamp, nonce, echostr) 拼接)；
 *   echostr 为 Base64 密文，解密后**原样输出明文**（协议要求 1s 内返回、
 *   不加引号/BOM/换行）。文档：developer.work.weixin.qq.com/document/path/90930
 * - 消息回调：POST XML（text/xml|application/xml），外层 <Encrypt> 字段参与
 *   验签（同法，echostr 换成 Encrypt）；解密后内层 XML 是消息体
 *   （ToUserName=corpid/FromUserName=userid/MsgType/Content/AgentID/MsgId/
 *   CreateTime，群聊带 ChatId）。文档：document/path/90968（接收消息和事件）
 * - 加解密：AESKey = Base64_Decode(EncodingAESKey + '=') → 32 字节；
 *   AES-256-CBC，IV = AESKey 前 16 字节；明文包
 *   FullStr = random(16B) + msg_len(4B 网络字节序) + msg + receiveid；
 *   PKCS#7 填充的 K 取密钥字节数 32（非常见 16）——故本实现关自动填充、
 *   手动按官方样例 strip/append（pad 值域 1..32 均合法）。
 *   验签/解密文档：document/path/90968#明文msg的加解密过程；多语言示例 document/path/90307
 * - 群触发即协议事实：自建应用群聊仅「@应用」才回调 → 群消息 mentionedBot
 *   恒 true，Content 带 "@应用名 " 前缀需剥离；dm 的 chatId=FromUserName。
 * - 出站：GET /cgi-bin/gettoken?corpid&corpsecret → access_token（expires_in
 *   7200，缓存并提前 300s 刷新）；POST /cgi-bin/message/send?access_token=
 *   body {touser, msgtype:'text', text:{content}, agentid, safe:0}——
 *   text 内容 utf-8 ≤2048 字节、markdown ≤20480 字节（本渠道统一走 text，
 *   分段归引擎按 caps.maxMessageLength）。文档：document/path/90236
 *   群聊回投：message/send 面无 chatid 参数，应用群聊（appchat 创建）回投走
 *   /cgi-bin/appchat/send{chatid,...}（document/path/90248）；普通群无法把
 *   自建应用当成员加入——首版群回复走 appchat/send，服务端确定性 errcode 浮现。
 * - errcode≠0 = 服务端明确拒绝（未处理本请求）→ 确定性 WeComAppApiError；
 *   40014（access_token 无效）/42001（过期）→ 清缓存重取 token 重试**一次**
 *   ——幂等口径：被拒请求未被投递，重试不会双发；再错照抛不盲试。
 *   网络/超时/响应体畸形 = 结果不明 → WeComAppUncertainError（D7：禁自动重发）。
 * - media_id 下载面（imageIn 的 GET /cgi-bin/media/get）首版未接——图片/文件
 *   入站以占位文案呈现，不丢消息；语音/视频同口径。
 * - 「微信插件路径」：自建应用消息可经 corp 的微信插件触达微信端用户（关注
 *   插件后应用消息同步到个人微信）——这是平台侧管理后台配置，非独立 API，
 *   代码侧无开关可验证 → diagnose 以 unverified 项 wechat-plugin-reach 提示。
 *
 * 回调驱动渠道无轮询：connect 即准备态（connected=true），消息由主会话把
 * HTTP 回调转发到 verifyUrl/handleXmlCallback 入内部队列并 emit；disconnect 清队列。
 * 运行时依赖零：node:crypto + 全局 fetch；测试注入 fetchImpl。
 * 安全红线：验签失败即 ok:false 不解析不解密回显；corpSecret/token/aesKey/
 * access_token 绝不进错误消息与诊断 hint（错误只带 errcode/errmsg）。
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChatAddress } from '../engine/router.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  Receipt,
  SemanticMessage,
} from './types.js'

const DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com'
/** text 内容 2048 字节上限按中文 3 字节/字保守（682→600），超限由引擎分段。 */
export const WECOM_APP_MAX_MESSAGE = 600
/** token 有效期 7200s，提前 300s 刷新（官方口径：过期前取新）。 */
const TOKEN_REFRESH_SKEW_MS = 300_000
/** text 内容协议硬限（utf-8 字节）。 */
const TEXT_CONTENT_MAX_BYTES = 2048

interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<Record<string, any>>
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>

/** 回调 query 的宽松形（HTTP 框架解出的 query map，值可缺省）。 */
export type CallbackQuery = Record<string, string | undefined>

/** errcode≠0 的确定性失败（服务端明确拒绝，未投递本请求）。 */
export class WeComAppApiError extends Error {
  constructor(
    message: string,
    readonly errcode: number,
  ) {
    super(message)
  }
}
/** 结果不明（网络/超时/响应体畸形）——D7：禁自动重发。 */
export class WeComAppUncertainError extends Error {}

// —— 加解密与验签（纯函数面，导出供单测直验/主会话复用） ————————————

/** token/timestamp/nonce/echostr|Encrypt 字典序拼接取 SHA1 十六进制（官方验签法）。 */
export function buildMsgSignature(parts: readonly string[]): string {
  return createHash('sha1').update([...parts].sort().join(''), 'utf8').digest('hex')
}

/** 验签：常量时间比对；缺参即 false（fail-closed）。 */
export function verifyMsgSignature(params: {
  token: string
  timestamp: string | undefined
  nonce: string | undefined
  encrypt: string | undefined
  msgSignature: string | undefined
}): boolean {
  const { token, timestamp, nonce, encrypt, msgSignature } = params
  if (timestamp === undefined || nonce === undefined || encrypt === undefined || msgSignature === undefined) {
    return false
  }
  const expected = buildMsgSignature([token, timestamp, nonce, encrypt])
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(msgSignature, 'utf8')
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function aesKeyOf(encodingAesKey: string): Buffer {
  const raw = encodingAesKey.length === 43 ? `${encodingAesKey}=` : encodingAesKey
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('wecom-app: EncodingAESKey 形态非法（应为 43 位随机串）')
  return key
}

/**
 * 加密明文消息 → Base64 密文。FullStr=random(16)+msg_len(4B 网络序)+msg+receiveid，
 * PKCS#7（K=32）手动填充后 AES-256-CBC（IV=key 前 16 字节）。
 * 出站回包加密（若主会话需要安全模式被动回复）与单测构造向量共用此面。
 */
export function encryptMessage(encodingAesKey: string, message: string, receiveId: string): string {
  const key = aesKeyOf(encodingAesKey)
  const msg = Buffer.from(message, 'utf8')
  const recv = Buffer.from(receiveId, 'utf8')
  const body = Buffer.alloc(16 + 4 + msg.length + recv.length)
  randomBytes(16).copy(body, 0)
  body.writeUInt32BE(msg.length, 16)
  msg.copy(body, 20)
  recv.copy(body, 20 + msg.length)
  const padLen = 32 - (body.length % 32) // 官方样例 K=32，值域 [1,32]
  const filled = Buffer.concat([body, Buffer.alloc(padLen, padLen)])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false) // Node 默认按块 16 strip，K=32 的填充必须手动承担
  return Buffer.concat([cipher.update(filled), cipher.final()]).toString('base64')
}

/** 解密 Base64 密文 → {message, receiveId}；结构/填充/长度不符即抛（fail-closed）。 */
export function decryptMessage(
  encodingAesKey: string,
  cipherBase64: string,
): { message: string; receiveId: string } {
  const key = aesKeyOf(encodingAesKey)
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(cipherBase64, 'base64')), decipher.final()])
  } catch (error) {
    throw new Error(`wecom-app: 密文 AES 解密失败（${String(error)}）`)
  }
  if (plain.length < 16 + 4) throw new Error('wecom-app: 明文包长度不足')
  const pad = plain[plain.length - 1] as number
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('wecom-app: PKCS#7 填充非法')
  const content = plain.subarray(16, plain.length - pad)
  const msgLen = content.readUInt32BE(0)
  if (content.length < 4 + msgLen) throw new Error('wecom-app: msg_len 与包体不一致')
  return {
    message: content.subarray(4, 4 + msgLen).toString('utf8'),
    receiveId: content.subarray(4 + msgLen).toString('utf8'),
  }
}

// —— 最小 XML 子集解析（禁引依赖；仅取 <字段>值</字段>/CDATA，够用即止） ——

/** 提取 XML 单字段文本（支持 CDATA；自闭合空标签返回空串；缺标签返回 undefined）。 */
export function extractXmlField(xml: string, field: string): string | undefined {
  const selfClosing = new RegExp(`<${field}\\s*/\\s*>`, 'i')
  if (selfClosing.test(xml)) return ''
  const pattern = new RegExp(`<${field}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${field}>`, 'i')
  const match = pattern.exec(xml)
  if (match === null) return undefined
  const value = match[1] ?? match[2] ?? ''
  return value.trim()
}

// —— 适配器 ——————————————————————————————————————————

export interface WecomAppAdapterOptions {
  corpId: string
  corpSecret: string
  /** 回调 Token（管理后台「接收消息」配置，验签用，非出站凭据）。 */
  callbackToken: string
  encodingAesKey: string
  /** 自建应用 AgentId（数字串，config 非 secret；出站必需）。 */
  agentId?: string
  apiBase?: string
  fetchImpl?: FetchLike
  logger?: (msg: string) => void
}

export class WecomAppAdapter implements ChannelAdapter {
  readonly id = 'wecom-app'
  readonly label = '企业微信应用'
  readonly caps: ChannelCaps = {
    // 应用消息无编辑/原生流式——引擎分段逐条 reply
    editStream: false,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    typing: false,
    // media_id 下载面（/cgi-bin/media/get）首版未接：入站图/文件占位文案不丢消息
    imageIn: false,
    fileIn: false,
    // 上传临时素材 media 面首版不接
    fileOut: false,
    threads: false,
    voice: false,
    maxMessageLength: WECOM_APP_MAX_MESSAGE,
  }

  /** 回调驱动：connect 即准备态置位，无长连接可建立 */
  connected = false
  private readonly corpId: string
  private readonly corpSecret: string
  private readonly callbackToken: string
  private readonly encodingAesKey: string
  private readonly agentId: string | undefined
  private readonly apiBase: string
  private readonly fetchImpl: FetchLike
  private readonly log: (msg: string) => void

  private listeners: MessageListener[] = []
  /** 内部入站队列（主会话可 drain；disconnect 清空）。 */
  private readonly inboundQueue: SemanticMessage[] = []
  /** MsgId 排重（企微回调会重放，协议要求开发者自行排重）。 */
  private readonly seenMsgIds = new Set<string>()
  /** access_token 缓存（7200s，提前 300s 视为过期）。 */
  private tokenCache: { value: string; expiresAt: number } | undefined

  constructor(options: WecomAppAdapterOptions) {
    if (!nonEmpty(options.corpId)) throw new Error('wecom-app: corpId 缺失（企业 ID，管理后台首页）')
    if (!nonEmpty(options.corpSecret)) throw new Error('wecom-app: corpSecret 缺失（应用密钥，管理后台应用页）')
    if (!nonEmpty(options.callbackToken)) throw new Error('wecom-app: callbackToken 缺失（接收消息配置的 Token）')
    if (!nonEmpty(options.encodingAesKey)) throw new Error('wecom-app: encodingAesKey 缺失（接收消息配置的加解密密钥）')
    this.corpId = options.corpId
    this.corpSecret = options.corpSecret
    this.callbackToken = options.callbackToken
    this.encodingAesKey = options.encodingAesKey
    this.agentId = nonEmpty(options.agentId ?? '') ? options.agentId : undefined
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike)
    this.log = options.logger ?? (() => {})
  }

  get connectionState(): boolean {
    return this.connected
  }

  async connect(signal?: AbortSignal): Promise<void> {
    // 回调模式没有连接可建：置准备态即完成（HTTP 端点归主会话接线）。
    void signal
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.inboundQueue.length = 0
    this.tokenCache = undefined
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  /** 取走并清空入站队列（回调已收但主会话尚未消费的消息）。 */
  drain(): SemanticMessage[] {
    return this.inboundQueue.splice(0, this.inboundQueue.length)
  }

  // —— 回调面（纯函数语义，导出供主会话接 GET 验证 / POST 消息端点） ————

  /**
   * GET 回调 URL 验证：验签（token,timestamp,nonce,echostr 字典序 SHA1）→
   * 解密 echostr → receiveid 校验为本企业 corpid → 返回解密明文
   * （协议要求原样输出，不加引号/BOM/换行）。任何一步不过 → null（拒绝）。
   */
  verifyUrl(query: CallbackQuery): string | null {
    const { msg_signature: msgSignature, timestamp, nonce, echostr } = query
    if (
      !verifyMsgSignature({ token: this.callbackToken, timestamp, nonce, encrypt: echostr, msgSignature })
    ) {
      return null
    }
    let message: string
    let receiveId: string
    try {
      ;({ message, receiveId } = decryptMessage(this.encodingAesKey, echostr as string))
    } catch (error) {
      this.log(`wecom-app: echostr 解密失败（${String(error)}）`)
      return null
    }
    if (receiveId !== this.corpId) return null // 跨企业路由/伪造——fail-closed
    return message
  }

  /**
   * POST 消息回调：外层 XML 的 <Encrypt> 验签（同法）→ 解密 → 内层消息 XML
   * 最小解析 → SemanticMessage 入内部队列并 emit 给 listeners。
   * 验签失败/密文非法 → {ok:false}，不解析不投递（安全红线）。
   * 事件类回调（菜单点击/订阅等）首版不消费 → {ok:true} 无 message。
   */
  handleXmlCallback(
    query: CallbackQuery,
    rawBody: string,
  ): { message?: SemanticMessage; ok: boolean } {
    const encrypt = extractXmlField(rawBody, 'Encrypt')
    if (
      encrypt === undefined ||
      !verifyMsgSignature({
        token: this.callbackToken,
        timestamp: query.timestamp,
        nonce: query.nonce,
        encrypt,
        msgSignature: query.msg_signature,
      })
    ) {
      return { ok: false }
    }
    let innerXml: string
    let receiveId: string
    try {
      ;({ message: innerXml, receiveId } = decryptMessage(this.encodingAesKey, encrypt))
    } catch (error) {
      this.log(`wecom-app: 回调密文解密失败（${String(error)}）`)
      return { ok: false }
    }
    if (receiveId !== this.corpId) return { ok: false } // 非本企业消息——丢弃
    const msgType = extractXmlField(innerXml, 'MsgType') ?? ''
    if (msgType === 'event') return { ok: true } // 事件回调首版不响应（菜单/订阅非对话输入）
    const msgId = extractXmlField(innerXml, 'MsgId')
    if (msgId !== undefined && msgId !== '') {
      if (this.seenMsgIds.has(msgId)) return { ok: true } // 重放排重（协议要求开发者自理）
      this.seenMsgIds.add(msgId)
      if (this.seenMsgIds.size > 500) {
        const first = this.seenMsgIds.values().next().value
        if (typeof first === 'string') this.seenMsgIds.delete(first)
      }
    }
    const message = this.normalizeInnerXml(innerXml, msgType)
    if (message === undefined) return { ok: false }
    this.inboundQueue.push(message)
    for (const listener of this.listeners) listener(message)
    return { message, ok: true }
  }

  /** 内层消息 XML → SemanticMessage（导出归一半供单测直验）。 */
  normalizeInnerXml(innerXml: string, msgTypeHint?: string): SemanticMessage | undefined {
    const msgType = msgTypeHint ?? extractXmlField(innerXml, 'MsgType') ?? ''
    const userId = extractXmlField(innerXml, 'FromUserName') ?? ''
    if (userId === '') return undefined
    // 群回调 ChatId 非空（自建应用群聊仅 @应用 才回调 → 被点名恒真）。
    const chatId = extractXmlField(innerXml, 'ChatId') ?? extractXmlField(innerXml, 'chatid') ?? ''
    const isGroup = chatId !== ''
    let text: string
    if (msgType === 'text') {
      text = extractXmlField(innerXml, 'Content') ?? ''
      // 群消息 Content 带 "@应用名 " 前缀（协议事实），剥离。
      if (isGroup) text = text.replace(/^@\S+\s+/, '').trimStart()
    } else if (msgType === 'image') {
      // media_id 下载面（/cgi-bin/media/get）首版未接——占位不丢消息。
      text = '[图片输入首版未接（media_id 下载面未实现）]'
    } else if (msgType === 'file') {
      text = '[文件输入首版未接（media_id 下载面未实现）]'
    } else if (msgType === 'voice') {
      text = '[语音输入暂不支持]'
    } else if (msgType === 'video' || msgType === 'shortvideo') {
      text = '[视频输入暂不支持]'
    } else {
      text = `[暂不支持的消息类型：${msgType === '' ? 'unknown' : msgType}]`
    }
    const address: ChatAddress = {
      channel: 'wecom-app',
      kind: isGroup ? 'group' : 'dm',
      chatId: isGroup ? chatId : userId,
    }
    const createTime = Number(extractXmlField(innerXml, 'CreateTime') ?? '')
    return {
      address,
      userId,
      text,
      mentionedBot: isGroup,
      ...(Number.isFinite(createTime) && createTime > 0 ? { timestamp: createTime * 1000 } : {}),
    }
  }

  // —— 出站 ——————————————————————————————————————————

  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > TEXT_CONTENT_MAX_BYTES) {
      // 引擎按 caps.maxMessageLength 分段后不应触达——防御性确定性拒绝，不截断盲发
      throw new Error(`wecom-app: text 内容 ${bytes} 字节，超协议上限 ${TEXT_CONTENT_MAX_BYTES}，应分段`)
    }
    if (address.kind === 'group') {
      // 协议事实：message/send 无群投参数；应用群聊（appchat 创建，ChatId 由
      // /cgi-bin/appchat/create 颁发）回投走 appchat/send——body 无 agentid。
      return this.sendWithTokenRetry('/cgi-bin/appchat/send', {
        chatid: address.chatId,
        msgtype: 'text',
        text: { content: text },
        safe: 0,
      }, signal)
    }
    if (this.agentId === undefined) throw new Error('wecom-app: agentId 未配置（出站消息必需，管理后台应用页）')
    return this.sendWithTokenRetry('/cgi-bin/message/send', {
      touser: address.chatId,
      msgtype: 'text',
      text: { content: text },
      agentid: Number(this.agentId),
      safe: 0,
    }, signal)
  }

  /**
   * 带 token 失效重试的发送：40014/42001 → 清缓存重取 token 重试一次。
   * 幂等口径：errcode≠0 = 服务端处理前明确拒绝、消息未投递，故换 token 重发
   * 一条不会双发；仅重试一次，仍失败照抛（不盲循环）。
   */
  private async sendWithTokenRetry(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Receipt> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const token = await this.getAccessToken(signal)
        const json = await this.postJson(path, token, body, signal)
        const errcode = Number(json.errcode ?? 0)
        if (errcode === 0) {
          return {
            platformMessageId: typeof json.msgid === 'string' ? json.msgid : undefined,
            uncertain: false,
          }
        }
        if ((errcode === 40014 || errcode === 42001) && attempt === 1) {
          this.tokenCache = undefined
          continue
        }
        throw new WeComAppApiError(`wecom-app: ${String(json.errmsg ?? '')}（errcode ${errcode}）`, errcode)
      } catch (error) {
        // 确定性 API 错误原样上抛；网络类已在 postJson/getAccessToken 包成 uncertain
        throw error
      }
    }
    throw new WeComAppUncertainError('wecom-app: 发送重试耗尽（不应抵达此分支）')
  }

  /** access_token 获取/缓存（expires_in 7200s，提前 300s 刷新）。 */
  async getAccessToken(signal?: AbortSignal): Promise<string> {
    const cache = this.tokenCache
    if (cache !== undefined && cache.expiresAt > Date.now()) return cache.value
    const url = `${this.apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.corpSecret)}`
    let response: FetchResponseLike
    try {
      response = await this.fetchImpl(url, { method: 'GET', ...(signal !== undefined ? { signal } : {}) })
    } catch (error) {
      // 错误消息不带 URL（URL 含 corpSecret）
      throw new WeComAppUncertainError(`wecom-app: gettoken 传输失败（${String(error)}），结果不明`)
    }
    if (!response.ok) throw new WeComAppApiError(`wecom-app: gettoken HTTP ${response.status}`, response.status)
    const json = await readJson(response)
    const errcode = Number(json.errcode ?? 0)
    if (errcode !== 0 || typeof json.access_token !== 'string') {
      // hint 只带 errcode/errmsg，凭据零回显
      throw new WeComAppApiError(`wecom-app: gettoken ${String(json.errmsg ?? '')}（errcode ${errcode}）`, errcode)
    }
    const expiresInMs = (typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 7200) * 1000
    this.tokenCache = { value: json.access_token, expiresAt: Date.now() + Math.max(expiresInMs - TOKEN_REFRESH_SKEW_MS, 0) }
    return json.access_token
  }

  private async postJson(
    path: string,
    accessToken: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, any>> {
    const url = `${this.apiBase}${path}?access_token=${encodeURIComponent(accessToken)}`
    let response: FetchResponseLike
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      // 请求是否已达服务端不可知——D7 uncertain，禁自动重发；消息不带 URL（含 token）
      throw new WeComAppUncertainError(`wecom-app: ${path} 传输失败（${String(error)}），结果不明`)
    }
    if (!response.ok) throw new WeComAppApiError(`wecom-app: ${path} HTTP ${response.status}`, response.status)
    return await readJson(response)
  }

  // —— 诊断三态 ——————————————————————————————————————————

  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = [
      {
        name: 'credentials',
        status:
          nonEmpty(this.corpId) && nonEmpty(this.corpSecret) && nonEmpty(this.callbackToken) && nonEmpty(this.encodingAesKey)
            ? 'passed'
            : 'failed',
        hint: 'CorpID/应用 Secret 在管理后台取；Token 与 EncodingAESKey 在应用「接收消息-API 接收」配置',
      },
    ]
    // gettoken 实探：只回 errcode/errmsg，任何 secret 零回显
    const started = Date.now()
    try {
      await this.getAccessToken(signal)
      checks.push({ name: 'gettoken', status: 'passed', elapsedMs: Date.now() - started })
    } catch (error) {
      if (error instanceof WeComAppApiError) {
        checks.push({ name: 'gettoken', status: 'failed', hint: error.message, elapsedMs: Date.now() - started })
      } else {
        checks.push({ name: 'gettoken', status: 'failed', hint: '网络结果不明，token 未取到', elapsedMs: Date.now() - started })
      }
    }
    checks.push(
      {
        name: 'callback',
        status: 'unverified',
        hint: 'URL 验证与消息回调须由企业微信服务器发起（管理后台保存回调 URL 时触发 GET 验证）',
      },
      {
        // 微信插件路径 = 平台侧配置：管理后台「企业应用 → 微信插件」启用后，
        // 自建应用消息可触达关注插件的微信端用户；API 面无开关可探测，只能提示。
        name: 'wechat-plugin-reach',
        status: 'unverified',
        hint: '微信端触达需企业先在管理后台启用「微信插件」并由用户关注（平台侧配置，代码不可探测）',
      },
      { name: 'roundtrip', status: 'unverified', hint: '收发 round-trip 需真机（企微客户端给应用发消息）验证' },
    )
    return checks
  }
}

/** 工厂读取口径：secrets.corpId/corpSecret/encodingAesKey + config.callbackToken/config.agentId。 */
export function createWecomAppAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): WecomAppAdapter {
  return new WecomAppAdapter({
    corpId: options.secrets.corpId ?? '',
    corpSecret: options.secrets.corpSecret ?? '',
    encodingAesKey: options.secrets.encodingAesKey ?? '',
    callbackToken: options.config.callbackToken ?? '',
    agentId: options.config.agentId,
  })
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value !== ''
}

async function readJson(response: FetchResponseLike): Promise<Record<string, any>> {
  try {
    return await response.json()
  } catch (error) {
    throw new WeComAppUncertainError(`wecom-app: 响应体 JSON 解析失败（${String(error)}），结果不明`)
  }
}
