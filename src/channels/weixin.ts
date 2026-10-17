/**
 * 微信渠道适配器（M1 P0，T1.2）——官方 iLink（智联）Bot 协议，ClawBot 通道。
 *
 * 红线 E2：只用腾讯官方开放的 iLink HTTP/JSON 协议（扫码授权，非逆向个人协议）。
 * 协议事实（官方协议文档 openclaw-weixin docs/protocol_zh_CN.md @2.4.x 独立重实现，
 * 净室口径——取协议字段知识，不复制其代码结构）：
 * - 鉴权头：AuthorizationType=ilink_bot_token + Authorization=Bearer <bot_token>
 *   + X-WECHAT-UIN（随机 uint32 十进制字符串再 base64，防重放）
 *   + iLink-App-Id / iLink-App-ClientVersion（0x00MMNNPP 十进制）；
 *   鉴权 POST 请求体带 base_info {channel_version, bot_agent}。
 * - 入站：POST /ilink/bot/getupdates 长轮询（服务端 hold ~35s，响应给
 *   longpolling_timeout_ms 建议下次超时；get_updates_buf 游标非空才滚动，
 *   不滚动会重复收）；ret/errcode=-14 = 会话过期需重新扫码（fail-closed 停轮）；
 *   连续失败退避（1s 起步，3 次后 30s——官方客户端行为口径）。
 * - 消息模型：WeixinMessage{from_user_id/to_user_id/message_type(1用户2Bot)/
 *   context_token/item_list/create_time_ms}；item type 1=text 2=image 3=voice
 *   4=file 5=video（11/12 工具项不消费）；voice_item.text 为语音转写。
 * - 回复绑定：sendmessage 必须回传该会话最近入站的 context_token（24h 无消息
 *   即过期，服务端拒投）；message_type=2、message_state=2（完成态——协议无
 *   编辑能力，editStream=false，收轮分段投递）；非零 ret = 确定性失败；
 *   缺 ret 字段不判失败（官方客户端行为口径）。
 * - typing：getConfig(ilink_user_id) → typing_ticket（缓存）→ sendtyping
 *   status 1=输入中 2=取消；5s 保活为官方建议（本实现 6 拍=30s 封顶）；
 *   sendtyping 响应不校验（官方客户端不解析）。
 * - 媒体 CDN：入站图/文件 = full_url 或 cdn/download?encrypted_query_param=
 *   GET 字节 → AES-128-ECB(PKCS7) 解密（密钥 image_item.aeskey 十六进制优先，
 *   次 media.aes_key base64→16 字节或 hex；都缺 = 明文直用）；
 *   出站 = 随机 16 字节 key 加密 → getuploadurl{filekey,media_type,rawsize,
 *   rawfilemd5,filesize,no_need_thumb,aeskey(hex)} → POST 密文
 *   (application/octet-stream) 到 upload_full_url 或 cdn/upload →
 *   HTTP 200 且响应头 x-encrypted-param 非空 = 成功（≤3 次尝试）→
 *   media{encrypt_query_param, aes_key=base64(hex串), encrypt_type:1}。
 * - 生命周期：连接建立发 /msg/notifystart、拆除发 /msg/notifystop，
 *   失败仅记日志不阻断（官方行为）。
 * - 平台限制（协议事实）：仅 1v1 私聊（bot 不能进群、无群回调）；不能主动
 *   发起会话（context_token 缺位时发送大概率失败——照发并让确定性错误浮现）。
 *
 * 运行时依赖零：Node≥22 全局 fetch + node:crypto；测试注入 fetchImpl。
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto'
import type { ChatAddress } from '../engine/router.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  OutboundFile,
  Receipt,
  SemanticMessage,
} from './types.js'

const DEFAULT_API_BASE = 'https://ilinkai.weixin.qq.com'
const DEFAULT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
const LONGPOLL_TIMEOUT_MS = 35_000
/** 任务口径（spec T1.2）：1800 字符分段（官方 textChunkLimit 4000，稳妥取小值）。 */
export const WEIXIN_MAX_MESSAGE = 1800
const TYPING_KEEPALIVE_MS = 5_000
const TYPING_MAX_BEATS = 6

interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<Record<string, any>>
  arrayBuffer?(): Promise<ArrayBuffer>
  headers?: { get(name: string): string | null }
}
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<FetchResponseLike>

/** 非零 ret/errcode 的确定性失败（协议可判，不重发不改内容盲试）。 */
export class WeixinApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}
/** 结果不明（网络/超时/关闭）——D7：禁自动重发。 */
export class WeixinUncertainError extends Error {}

export interface WeixinAdapterOptions {
  botToken: string
  apiBase?: string
  cdnBase?: string
  channelVersion?: string
  fetchImpl?: FetchLike
  logger?: (msg: string) => void
}

/** 业务响应判错：ret 或 errcode 非零即失败；-14 会话过期单独标记。 */
function bizCheck(json: Record<string, any>): { ok: true; expired: boolean } | { ok: false; error: WeixinApiError } {
  const code = json.ret !== undefined && json.ret !== 0 ? Number(json.ret) : Number(json.errcode ?? 0)
  if (code === 0) return { ok: true, expired: false }
  const expired = code === -14
  return { ok: false, error: new WeixinApiError(`微信 iLink: ${String(json.errmsg ?? '')}（code ${code}）${expired ? '，会话过期需重新扫码' : ''}`, code) }
}

/** AES-128-ECB 加密（PKCS7 填充由 Node 默认承担），返回密文与十六进制密钥。 */
export function aesEncrypt(plain: Uint8Array): { cipher: Uint8Array; keyHex: string } {
  const key = randomBytes(16)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const out = Buffer.concat([cipher.update(plain), cipher.final()])
  return { cipher: new Uint8Array(out), keyHex: key.toString('hex') }
}

/** AES-128-ECB 解密；密钥三形态：32 位 hex / base64(16 字节) / base64(hex 串)。 */
export function aesDecrypt(blob: Uint8Array, keySpec: string): Uint8Array {
  let key: Buffer | undefined
  if (/^[0-9a-fA-F]{32}$/.test(keySpec)) key = Buffer.from(keySpec, 'hex')
  else {
    try {
      const decoded = Buffer.from(keySpec, 'base64')
      if (decoded.length === 16) key = decoded
      else if (decoded.length === 32 && /^[0-9a-fA-F]*$/.test(decoded.toString('latin1'))) key = Buffer.from(decoded.toString('latin1'), 'hex')
    } catch {
      /* fallthrough */
    }
  }
  if (key === undefined) throw new Error('微信 iLink: 无法解析 AES 密钥形态')
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return new Uint8Array(Buffer.concat([decipher.update(blob), decipher.final()]))
}

export class WeixinAdapter implements ChannelAdapter {
  readonly id = 'weixin'
  readonly label = '微信'
  readonly caps: ChannelCaps = {
    editStream: false,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    typing: true,
    imageIn: true,
    fileIn: true,
    fileOut: true,
    threads: false,
    voice: false,
    maxMessageLength: WEIXIN_MAX_MESSAGE,
  }

  connected = false
  /** errcode=-14：token 过期，须重新扫码授权（禁盲重试）。 */
  authExpired = false
  private readonly token: string
  private readonly apiBase: string
  private readonly cdnBase: string
  private readonly channelVersion: string
  private readonly fetchImpl: FetchLike
  private readonly log: (msg: string) => void

  private listeners: MessageListener[] = []
  private pollController: AbortController | undefined
  /** 长轮询游标（非空才滚动，协议事实）。 */
  private updatesBuf = ''
  private longpollTimeoutMs = LONGPOLL_TIMEOUT_MS
  /** user → 最近入站 context_token（回复必回传；24h 服务端过期）。 */
  private readonly contextTokens = new Map<string, string>()
  /** user → typing ticket。 */
  private readonly typingTickets = new Map<string, string>()
  private readonly typingKeepalives = new Map<string, ReturnType<typeof setInterval>>()

  constructor(options: WeixinAdapterOptions) {
    if (typeof options.botToken !== 'string' || options.botToken === '') {
      throw new Error('weixin: botToken 缺失（iLink 需扫码登录获取，见账号绑定）')
    }
    this.token = options.botToken
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
    this.cdnBase = (options.cdnBase ?? DEFAULT_CDN_BASE).replace(/\/+$/, '')
    this.channelVersion = options.channelVersion ?? '0.0.1'
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike)
    this.log = options.logger ?? (() => {})
  }

  get connectionState(): boolean {
    return this.connected
  }

  // —— 生命周期 ——————————————————————————————————

  async connect(signal?: AbortSignal): Promise<void> {
    // notifyStart 失败不阻断（官方行为），仅诊断可见。
    await this.post('/ilink/bot/msg/notifystart', {}, { auth: true }).catch(() => undefined)
    this.connected = true
    this.pollController = new AbortController()
    if (signal !== undefined) signal.addEventListener('abort', () => this.pollController?.abort(), { once: true })
    void this.pollLoop(this.pollController.signal)
  }

  async disconnect(): Promise<void> {
    // 软停轮询（循环条件见 lifecycleGate）；在途/收尾请求（notifystop、
    // 测试拆除后 reply）仍可发出——否则协议生命周期通知永远发不出去。
    this.pollController?.abort()
    for (const timer of this.typingKeepalives.values()) clearInterval(timer)
    this.typingKeepalives.clear()
    this.connected = false
    await this.post('/ilink/bot/msg/notifystop', {}, { auth: true, lifecycleGate: false }).catch(() => undefined)
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // —— 入站长轮询 ——————————————————————————————————

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000
    let consecutiveFailures = 0
    while (!signal.aborted && this.connected) {
      try {
        const json = await this.post(
          '/ilink/bot/getupdates',
          { get_updates_buf: this.updatesBuf },
          { auth: true, timeoutMs: this.longpollTimeoutMs + 5_000, signal, lifecycleGate: false },
        )
        const check = bizCheck(json)
        if (!check.ok) {
          if (check.error.code === -14) {
            this.authExpired = true
            this.log('weixin: 会话过期（-14），停止轮询，需重新扫码授权')
            return
          }
          throw check.error
        }
        backoffMs = 1_000
        consecutiveFailures = 0
        if (typeof json.longpolling_timeout_ms === 'number' && json.longpolling_timeout_ms > 0) {
          this.longpollTimeoutMs = json.longpolling_timeout_ms
        }
        // 游标非空才滚动（协议事实：空回传会重复收旧消息）。
        if (typeof json.get_updates_buf === 'string' && json.get_updates_buf !== '') {
          this.updatesBuf = json.get_updates_buf
        }
        const msgs = Array.isArray(json.msgs) ? json.msgs : []
        for (const msg of msgs) {
          const message = await this.fillMedia(msg)
          if (message !== undefined) {
            for (const listener of this.listeners) listener(message)
          }
        }
      } catch (error) {
        if (signal.aborted || !this.connected) return
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return // 长轮询超时/取消：空结果口径，立即下轮
        consecutiveFailures += 1
        // 官方客户端口径：连续失败 3 次退避 30 秒。
        const wait = consecutiveFailures >= 3 ? 30_000 : backoffMs
        backoffMs = Math.min(backoffMs * 2, 30_000)
        this.log(`weixin: 轮询失败（连续 ${consecutiveFailures} 次），${wait}ms 后重试`)
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
  }

  /** 回调消息 → SemanticMessage + 媒体填充（导出归一半供单测直验）。 */
  async fillMedia(raw: Record<string, any>): Promise<SemanticMessage | undefined> {
    if (Number(raw.message_type) === 2) return undefined // bot 自发回声丢弃
    const userId = typeof raw.from_user_id === 'string' ? raw.from_user_id : ''
    if (userId === '') return undefined
    if (typeof raw.context_token === 'string' && raw.context_token !== '') {
      this.contextTokens.set(userId, raw.context_token)
    }
    const items: Array<Record<string, any>> = Array.isArray(raw.item_list) ? raw.item_list : []
    const texts: string[] = []
    const images: Array<{ name: string; data: Uint8Array; mimeType: string }> = []
    const files: Array<{ name: string; data: Uint8Array }> = []
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text !== undefined) texts.push(String(item.text_item.text))
      else if (item.type === 2) {
        const blob = await this.downloadMedia(item.image_item?.media ?? item.image_item, String(item.image_item?.aeskey ?? ''))
        if (blob !== undefined) images.push({ name: `photo_${String(item.msg_id ?? images.length)}.jpg`, data: blob, mimeType: 'image/jpeg' })
        else texts.push('[图片下载失败]')
      } else if (item.type === 3) {
        // 协议事实：voice_item.text 为服务端转写文本，优先消费。
        const voice = item.voice_item ?? {}
        texts.push(voice.text !== undefined ? `[语音] ${String(voice.text)}` : '[语音消息]')
      } else if (item.type === 4) {
        const file = item.file_item ?? {}
        const blob = await this.downloadMedia(file.media, '')
        if (blob !== undefined && file.media?.aes_key !== undefined) {
          files.push({ name: String(file.file_name ?? `file_${images.length + files.length}`), data: blob })
        } else if (blob !== undefined) files.push({ name: String(file.file_name ?? 'file'), data: blob })
        else texts.push('[文件下载失败]')
      } else if (item.type === 5) texts.push('[视频消息暂不支持]')
    }
    const address: ChatAddress = { channel: 'weixin', kind: 'dm', chatId: userId }
    return {
      address,
      userId,
      text: texts.join('\n'),
      mentionedBot: false,
      images: images.length > 0 ? images : undefined,
      files: files.length > 0 ? files : undefined,
      timestamp: typeof raw.create_time_ms === 'number' ? raw.create_time_ms : undefined,
    }
  }

  /** CDN 下载 + 解密（密钥缺失明文直用——官方图片口径）。 */
  private async downloadMedia(media: Record<string, any> | undefined, hexKeyPriority: string): Promise<Uint8Array | undefined> {
    if (media === undefined) return undefined
    const url =
      typeof media.full_url === 'string' && media.full_url !== ''
        ? media.full_url
        : typeof media.encrypt_query_param === 'string'
          ? `${this.cdnBase}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
          : undefined
    if (url === undefined) return undefined
    try {
      const response = await this.fetchImpl(url, { method: 'GET' })
      if (!response.ok || response.arrayBuffer === undefined) return undefined
      const bytes = new Uint8Array(await response.arrayBuffer())
      const keySpec = hexKeyPriority !== '' ? hexKeyPriority : String(media.aes_key ?? '')
      if (keySpec === '') return bytes // 明文直用
      try {
        return aesDecrypt(bytes, keySpec)
      } catch {
        return undefined // 解密失败按失败处理（不把密文当图片喂下游）
      }
    } catch {
      return undefined
    }
  }

  // —— 出站 ——————————————————————————————————————

  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    return this.sendItems(address, [{ type: 1, text_item: { text } }], signal)
  }

  async sendFile(address: ChatAddress, file: OutboundFile, signal?: AbortSignal): Promise<Receipt> {
    const isImage = (file.mimeType ?? '').startsWith('image/')
    const uploaded = await this.uploadToCdn(file.data, address.chatId, isImage ? 1 : 3, signal)
    const item = isImage
      ? { type: 2, image_item: { media: uploaded.media, encrypt_type: 1, mid_size: uploaded.cipherSize } }
      : { type: 4, file_item: { media: uploaded.media, file_name: file.name, len: String(file.data.length) } }
    return this.sendItems(address, [item], signal)
  }

  private async sendItems(address: ChatAddress, itemList: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<Receipt> {
    const contextToken = this.contextTokens.get(address.chatId)
    const body: Record<string, unknown> = {
      msg: {
        from_user_id: '',
        to_user_id: address.chatId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: itemList,
        ...(contextToken !== undefined ? { context_token: contextToken } : {}),
      },
    }
    if (contextToken === undefined) this.log('weixin: 缺少 context_token，服务端可能拒投（不能主动发起会话）')
    const json = await this.post('/ilink/bot/sendmessage', body, { auth: true, signal })
    const check = bizCheck(json)
    if (!check.ok) throw check.error
    return { uncertain: false }
  }

  /** CDN 上传链路（协议 7 步；成功=HTTP 200 且 x-encrypted-param 非空，≤3 次）。 */
  private async uploadToCdn(plain: Uint8Array, toUserId: string, mediaType: 1 | 2 | 3 | 4, signal?: AbortSignal): Promise<{ media: Record<string, unknown>; cipherSize: number }> {
    const { cipher, keyHex } = aesEncrypt(plain)
    const rawMd5 = createHash('md5').update(plain).digest('hex')
    const filekey = randomBytes(16).toString('hex')
    let lastError: Error = new WeixinUncertainError('weixin: 上传未执行')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const uploadJson = await this.post(
          '/ilink/bot/getuploadurl',
          {
            filekey,
            media_type: mediaType,
            to_user_id: toUserId,
            rawsize: plain.length,
            rawfilemd5: rawMd5,
            filesize: cipher.length,
            no_need_thumb: true,
            aeskey: keyHex,
          },
          { auth: true, signal },
        )
        const uploadParam = typeof uploadJson.upload_param === 'string' ? uploadJson.upload_param : ''
        const fullUrl = typeof uploadJson.upload_full_url === 'string' && uploadJson.upload_full_url !== '' ? uploadJson.upload_full_url : undefined
        if (uploadParam === '' && fullUrl === undefined) throw new WeixinApiError('微信 iLink: getuploadurl 未返回上传参数', -1)
        const url = fullUrl ?? `${this.cdnBase}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${filekey}`
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.from(cipher),
          ...(signal !== undefined ? { signal } : {}),
        })
        const xparam = response.headers?.get?.('x-encrypted-param') ?? null
        if (response.status !== 200 || xparam === null || xparam === '') {
          if (response.status >= 400 && response.status < 500) throw new WeixinApiError(`微信 iLink: CDN 上传被拒（HTTP ${response.status}）`, response.status)
          throw new WeixinUncertainError(`微信 iLink: CDN 上传结果不明（HTTP ${response.status}）`)
        }
        return {
          // 官方发送器口径：十六进制密钥串再做 base64。
          media: { encrypt_query_param: xparam, aes_key: Buffer.from(keyHex, 'utf8').toString('base64'), encrypt_type: 1 },
          cipherSize: cipher.length,
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (lastError instanceof WeixinApiError) throw lastError // 确定性失败不重试
        if (error instanceof WeixinUncertainError && attempt === 3) throw error
      }
    }
    throw lastError
  }

  // —— typing ——————————————————————————————————————

  async setTyping(address: ChatAddress): Promise<void> {
    try {
      let ticket = this.typingTickets.get(address.chatId)
      if (ticket === undefined) {
        const json = await this.post('/ilink/bot/getconfig', { ilink_user_id: address.chatId }, { auth: true })
        if (Number(json.ret ?? 0) === 0 && typeof json.typing_ticket === 'string') {
          ticket = json.typing_ticket
          this.typingTickets.set(address.chatId, ticket)
        }
      }
      if (ticket === undefined) return
      await this.post('/ilink/bot/sendtyping', { ilink_user_id: address.chatId, typing_ticket: ticket, status: 1 }, { auth: true }).catch(() => undefined)
      // 官方建议 5s 保活；本实现 6 拍（30s）封顶，回复发出即停。
      this.stopTypingKeepalive(address.chatId)
      let beats = 0
      const timer = setInterval(() => {
        beats += 1
        if (beats >= TYPING_MAX_BEATS) {
          this.stopTypingKeepalive(address.chatId)
          return
        }
        void this.post('/ilink/bot/sendtyping', { ilink_user_id: address.chatId, typing_ticket: ticket, status: 1 }, { auth: true }).catch(() => undefined)
      }, TYPING_KEEPALIVE_MS)
      timer.unref?.()
      this.typingKeepalives.set(address.chatId, timer)
    } catch {
      /* typing 是尽力而为的锦上添花，失败静默 */
    }
  }

  private stopTypingKeepalive(userId: string): void {
    const timer = this.typingKeepalives.get(userId)
    if (timer !== undefined) clearInterval(timer)
    this.typingKeepalives.delete(userId)
  }

  // —— HTTP 面 ——————————————————————————————————————

  private async post(
    path: string,
    body: Record<string, unknown>,
    opts: { auth: boolean; signal?: AbortSignal; timeoutMs?: number; lifecycleGate?: boolean },
  ): Promise<Record<string, any>> {
    // 连接闸：非连接态的业务请求拒发（防已拆适配器盲发/退避风暴）；
    // 轮询循环自身与 notifystart/stop 生命周期通知不受此闸约束。
    if (!this.connected && opts.lifecycleGate !== false && path !== '/ilink/bot/msg/notifystart') {
      throw new WeixinUncertainError('weixin: 长连接未就绪，发送结果不确定')
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(encodeClientVersion(this.channelVersion)),
    }
    if (opts.auth) {
      headers.AuthorizationType = 'ilink_bot_token'
      headers.Authorization = `Bearer ${this.token}`
      headers['X-WECHAT-UIN'] = randomWechatUin()
    }
    const payload = opts.auth ? { ...body, base_info: { channel_version: this.channelVersion, bot_agent: 'dsh-im-union' } } : body
    const timeoutSignal = opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined
    const signal = opts.signal !== undefined && timeoutSignal !== undefined
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : opts.signal ?? timeoutSignal
    let response: FetchResponseLike
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, { method: 'POST', headers, body: JSON.stringify(payload), ...(signal !== undefined ? { signal } : {}) })
    } catch (error) {
      if (opts.signal?.aborted === true) throw error // 外部取消：拆轮询，不判不确定
      throw new WeixinUncertainError(`微信 iLink: 请求 ${path} 传输失败（${String(error)}），结果不明`)
    }
    if (!response.ok) throw new WeixinApiError(`微信 iLink: ${path} HTTP ${response.status}`, response.status)
    return await response.json()
  }

  // —— 诊断三态 ——————————————————————————————————————

  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = [
      { name: 'credentials', status: this.token !== '' ? 'passed' : 'failed', hint: '微信 iLink 需扫码登录获取 bot_token（账号绑定页发起）' },
    ]
    if (this.authExpired) {
      checks.push({ name: 'session', status: 'failed', hint: '会话过期（-14），需重新扫码授权' })
      return checks
    }
    // 用一次短超时 getupdates 探活（空游标请求即官方 token 校验法）。
    const started = Date.now()
    try {
      const json = await this.post('/ilink/bot/getupdates', { get_updates_buf: this.updatesBuf }, { auth: true, timeoutMs: 5_000, signal, lifecycleGate: false })
      const check = bizCheck(json)
      checks.push({
        name: 'session',
        status: check.ok ? 'passed' : 'failed',
        hint: check.ok ? undefined : check.error.message,
        elapsedMs: Date.now() - started,
      })
      if (!check.ok && check.error.code === -14) this.authExpired = true
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        checks.push({ name: 'session', status: 'unverified', hint: '诊断被取消' })
      } else if (error instanceof WeixinApiError) {
        checks.push({ name: 'session', status: 'failed', hint: error.message })
      } else {
        checks.push({ name: 'session', status: 'unverified', hint: '网络结果不明，未据此判死' })
      }
    }
    checks.push({ name: 'roundtrip', status: 'unverified', hint: '真机收发 round-trip 需微信扫码用户实测' })
    return checks
  }
}

/** 随机 uint32 → 十进制字符串 → base64（协议防重放头）。 */
export function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

/** 版本 x.y.z → 0x00MMNNPP 十进制。 */
export function encodeClientVersion(version: string): number {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10) || 0)
  return ((parts[0] ?? 0) << 16) | ((parts[1] ?? 0) << 8) | (parts[2] ?? 0)
}

export function createWeixinAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): WeixinAdapter {
  return new WeixinAdapter({
    botToken: options.secrets.botToken ?? '',
    ...(options.config.apiBase !== undefined ? { apiBase: options.config.apiBase } : {}),
    ...(options.config.cdnBase !== undefined ? { cdnBase: options.config.cdnBase } : {}),
  })
}
