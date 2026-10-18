/**
 * Matrix olm E2EE 入站解密核心（A 档：Megolm 入站解密，出站不加密）。
 *
 * 净室口径：协议事实全部取自 Matrix 公开客户端-服务器规范 v1.11 与 olm/Megolm
 * 算法文档独立重实现，未参考任何第三方 SDK（matrix-js-sdk / matrix-bot-sdk /
 * matrix-nio）源码结构。
 *
 * 协议锚点（https://spec.matrix.org/v1.11/client-server-api/）：
 * - E2EE 总览：/#end-to-end-encryption（Megolm 房间消息 + Olm 设备间会话的两层结构）。
 * - 设备密钥引导：Olm Account 生成本设备的 ed25519（签名）/curve25519（身份）密钥对
 *   （olm 文档 https://gitlab.matrix.org/matrix-org/olm/blob/master/docs/olm.md，
 *   olm_account_identity_keys 返回 JSON）。公开规范里**没有** `/_matrix/client/v3/
 *   crypto/device_keys` 这个端点（任务锚点与规范不符，如实登记）；规范端点为
 *   `PUT /_matrix/client/v3/keys/device_keys`（/#put_matrixclientv3keysdevicekeys）
 *   与 `POST /_matrix/client/v3/keys/upload`（/#post_matrixclientv3keysupload，
 *   同一调用可携带 device_keys + one_time_keys，响应 one_time_key_counts）。
 *   本实现走后者（一次调用完成设备密钥发布 + one-time keys 上报）。
 *   device_keys 体：`{user_id, device_id, algorithms, keys:{'<alg>:<device_id>':key},
 *   signatures:{<user_id>:{'ed25519:<device_id>':sig}}}`；签名走 Canonical JSON
 *   （键字典序 + UTF-8 + `~`→`~0`、`/`→`~1` 转义，/#signing-json +
 *   /#canonical-v1 口径），签名对象为剔除 signatures 属性后的 JSON。
 *   one-time keys 以 `signed_curve25519:<key_id>` 形态上传，每个密钥独立签名
 *   （/#uploading-one-time-keys：被签对象为仅含 `key` 的 JSON）。
 * - to-device 事件：sync 响应顶层 `to_device.events[]`（/#get_matrixclientv3sync +
 *   /#to-device）。`m.room_key` 事件 content =
 *   `{algorithm:'m.megolm.v1.aes-sha2', room_id, session_id, session_key}`
 *   （/#mroom_key；session_key 即 Megolm 会话导出的 base64，含
 *   session_id/起始 message_index，Megolm 文档
 *   https://gitlab.matrix.org/matrix-org/olm/blob/master/docs/megolm.md）。
 * - 加密消息：时间线 `m.room.encrypted`（/#mroomencrypted），Megolm 形 content =
 *   `{algorithm:'m.megolm.v1.aes-sha2', sender_key, session_id, ciphertext,
 *   device_id?}`；ciphertext 为 base64 Megolm 帧，解密得**被加密事件的 JSON**
 *   （至少含 type/content）。Megolm 帧的 HMAC 由会话密钥 + 发送方 curve25519
 *   派生，规范据此以 content.sender_key 标识发送设备。
 * - one-time keys 计数：sync 响应 `device_one_time_keys_count`
 *   （/#client-server-api-encryption-module），低于水位时应经
 *   `POST /keys/upload` 补充（本实现做最小补充面）。
 * - 跨设备建立 Olm 会话需 `POST /keys/query` + `POST /keys/claim`
 *   （/#post_matrixclientv3keysquery、/#post_matrixclientv3keysclaim）+ m.room_key
 *   的 Olm 加密投递（send-to-device PUT /sendToDevice/{type}/{txnId}）——
 *   **本 A 档不实现 claim/forward 全链**。
 *
 * A 档边界声明（如实，不伪称全 E2EE）：
 * 「仅覆盖会话内已分发 room_key 的解密，跨设备分享不完整。」
 * - 入站：只解密经 to-device `m.room_key` 送达本设备的 Megolm 会话密钥；密钥未达
 *   的消息不解密（required 档给占位「[加密消息：密钥未达，A 档不保证跨设备分享]」）。
 * - 出站：一律明文（不实现 Megolm 加密出站），已启用加密的房间能否收下明文由
 *   homeserver 裁决，本包不承诺入站解密与出站加密的档位对称。
 * - 无 m.room_key_request（/#mroom_key_request）应答、无 MSC3708 密钥备份、
 *   无交叉签名；新设备无法取回历史消息密钥。
 * - device_id 由 accessToken 哈希派生（不引入状态文件路径依赖）：同 token+user 重启
 *   同设备稳定；token 轮换即换设备身份，旧设备已分发的 room_key 不会跟来（A 档已知限）。
 *
 * 本包 @matrix-org/olm@3.2.15 js 绑定实测形态（index.d.ts 口径）：
 * `Account.identity_keys()/one_time_keys()` 返回 **JSON 字符串**；
 * `InboundGroupSession.decrypt(ciphertextBase64)` 为**单参形态**，返回
 * `{message_index, plaintext}`；该绑定不暴露 megolm 帧内 senders_key，故
 * sender_key 一致性在 JS 层校验（session 记账 room_key 事件 sender 与加密事件
 * content.sender_key，两者在位即比对，不匹配判解密失败）。
 */
import { createHash } from 'node:crypto'
import type { MatrixEvent } from './matrix.js'

/** Megolm 算法名（规范唯一在用的房间消息算法）。 */
export const MEGOLM_ALGORITHM = 'm.megolm.v1.aes-sha2'
/** one-time keys 低于该水位即补充（规范建议维持 max_number_of_one_time_keys 的一半）。 */
export const ONETIME_KEY_FLOOR = 5

// —— 可注入 olm 面（测试 fake / 真包 WASM 双轨）—————————————————

/** olm Account 用到的子集（宽松签名：3.2.15 绑定返回 JSON string，新版返回对象）。 */
export interface OlmAccountLike {
  create(): void
  free?(): void
  identity_keys(): string | Record<string, any>
  sign(message: string): string
  one_time_keys(): string | Record<string, any>
  generate_one_time_keys(count: number): void
  mark_keys_as_published(): void
  max_number_of_one_time_keys(): number
}
export interface OlmInboundGroupSessionLike {
  create(session_key: string): string | void
  free?(): void
  decrypt(message: string): { message_index: number; plaintext: string }
}
export interface OlmNamespaceLike {
  Account: new () => OlmAccountLike
  InboundGroupSession: new () => OlmInboundGroupSessionLike
  init?: (opts?: Record<string, unknown>) => Promise<void>
}
/** 工厂注入面：`() => Promise<olm 命名空间>`，测试传 fake，宿主传 loadRealOlm。 */
export type OlmFactory = () => Promise<OlmNamespaceLike>

/**
 * 真包加载：动态 import('@matrix-org/olm') 并 init WASM。
 * 类型经 unknown 收口——d.ts 是 UMD 命名空间形态，ESM 运行时默认导出才挂构造函数。
 * 实测 @matrix-org/olm@3.2.15：Account/InboundGroupSession 等构造器在 **init() 之后**
 * 才挂到命名空间上（Emscripten 延迟导出），故先 init 再校验构造器在位。
 */
export async function loadRealOlm(): Promise<OlmNamespaceLike> {
  const mod: unknown = await import('@matrix-org/olm')
  const record = mod as Record<string, any>
  const olm = (typeof record.default === 'object' && record.default !== null
    ? record.default
    : record) as OlmNamespaceLike
  await olm.init?.()
  if (typeof olm.Account !== 'function' || typeof olm.InboundGroupSession !== 'function') {
    throw new Error('olm: 加载到的模块缺少 Account/InboundGroupSession 构造器（非规范绑定形态）')
  }
  return olm
}

/**
 * Canonical JSON（/#canonical-v1）：对象键按 Unicode 码点字典序、无空白，
 * 字符串内 `~`→`~0`、`/`→`~1`（供 ed25519 签名口径）。数组保序。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value.replace(/~/g, '~0').replace(/\//g, '~1'))
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts = keys.map((key) => `${JSON.stringify(key.replace(/~/g, '~0').replace(/\//g, '~1'))}:${canonicalJson(record[key])}`)
  return `{${parts.join(',')}}`
}

/** olm 绑定返回 JSON string 或对象两形态都能解析为记录。 */
function parseOlmJson(raw: string | Record<string, any>, what: string): Record<string, any> {
  if (typeof raw === 'object' && raw !== null) return raw
  if (typeof raw !== 'string' || raw === '') throw new Error(`olm: ${what} 返回值不可解析为 JSON`)
  const parsed = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`olm: ${what} 返回值非对象`)
  return parsed as Record<string, any>
}

/** device_id 派生：sha256(userId + accessToken) 前 12 位大写 hex。 */
export function deriveDeviceId(accessToken: string, userId = ''): string {
  return createHash('sha256')
    .update(`dsh-im-union-e2ee-v1|${userId}|${accessToken}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
}

interface StoredGroupSession {
  /** m.room_key 事件来源（to-device 外层 sender），加密事件 sender 不一致即拒绝。 */
  issuerUserId: string
  /** 首解密时记录的发送设备 curve25519（与后续事件 sender_key 对拍）。 */
  senderKey: string
  session: OlmInboundGroupSessionLike
}

export interface MatrixE2eeCryptoOptions {
  olmFactory: OlmFactory
  logger?: (msg: string) => void
  /** one-time keys 补充目标数（缺省 10，不超 olm 上限）。 */
  oneTimeKeyTarget?: number
}

/**
 * Megolm 入站解密核心：Account 引导 → device_keys/one_time_keys 上报 payload →
 * to-device m.room_key 存会话 → m.room.encrypted 解回事件 JSON。
 * 不持有 HTTP 面（由 matrix.ts 的 requestJson 调用方投递 payload），可独立单测。
 */
export class MatrixE2eeCrypto {
  /** olm 命名空间 + Account 就绪位（加载失败即 false，调用方决定拒连/占位）。 */
  ready = false
  /** 最近一次初始化/解密失败原因（诊断如实上报用，不含 token）。 */
  lastError = ''
  private readonly olmFactory: OlmFactory
  private readonly log: (msg: string) => void
  private readonly oneTimeKeyTarget: number
  private olm: OlmNamespaceLike | undefined
  private account: OlmAccountLike | undefined
  /** `${roomId}|${sessionId}` → 会话（m.room_key 按 room_id+session_id 记账）。 */
  private readonly sessions = new Map<string, StoredGroupSession>()

  constructor(options: MatrixE2eeCryptoOptions) {
    this.olmFactory = options.olmFactory
    this.log = options.logger ?? (() => {})
    this.oneTimeKeyTarget = options.oneTimeKeyTarget ?? 10
  }

  /** 加载 olm（工厂注入：真 WASM 或 fake）并创建 Account。幂等。 */
  async init(): Promise<boolean> {
    if (this.ready) return true
    try {
      const olm = await this.olmFactory()
      await olm.init?.()
      const account = new olm.Account()
      account.create()
      this.olm = olm
      this.account = account
      this.ready = true
      this.lastError = ''
      return true
    } catch (error) {
      this.ready = false
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log(`matrix e2ee: olm 解密面加载失败: ${this.lastError}`)
      return false
    }
  }

  /** 本设备身份密钥（curve25519/ed25519）；未就绪返回 undefined。 */
  identityKeys(): { curve25519: string; ed25519: string } | undefined {
    if (this.account === undefined) return undefined
    try {
      const raw = parseOlmJson(this.account.identity_keys(), 'identity_keys')
      if (typeof raw.curve25519 !== 'string' || typeof raw.ed25519 !== 'string') return undefined
      return { curve25519: raw.curve25519, ed25519: raw.ed25519 }
    } catch (error) {
      this.log(`matrix e2ee: identity_keys 解析失败: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * 组装 `POST /_matrix/client/v3/keys/upload` 请求体：
   * `{device_keys:{user_id,device_id,algorithms,keys,signatures}, one_time_keys}`。
   * one-time keys 先取未发布的，不足目标数则 generate 补足；组装后 mark 已发布
   * （规范：客户端上传后须标记防重复发布）。
   */
  deviceKeysPayload(userId: string, deviceId: string): Record<string, any> | undefined {
    if (this.account === undefined || this.olm === undefined) return undefined
    const identity = this.identityKeys()
    if (identity === undefined) return undefined
    const signPayload = (payload: Record<string, unknown>): string => this.account!.sign(canonicalJson(payload))
    const unsigned = {
      user_id: userId,
      device_id: deviceId,
      algorithms: [MEGOLM_ALGORITHM],
      keys: {
        [`curve25519:${deviceId}`]: identity.curve25519,
        [`ed25519:${deviceId}`]: identity.ed25519,
      },
    }
    const deviceKeys = {
      ...unsigned,
      signatures: { [userId]: { [`ed25519:${deviceId}`]: signPayload(unsigned) } },
    }
    const oneTimeKeys = this.collectOneTimeKeys(deviceId, userId)
    return oneTimeKeys === undefined ? { device_keys: deviceKeys } : { device_keys: deviceKeys, one_time_keys: oneTimeKeys }
  }

  /** 未发布 one-time keys → signed_curve25519 签名形态；缺位则先生成。 */
  private collectOneTimeKeys(deviceId: string, userId: string): Record<string, unknown> | undefined {
    const account = this.account
    if (account === undefined) return undefined
    try {
      let pool = parseOlmJson(account.one_time_keys(), 'one_time_keys')
      const curve: Record<string, any> = typeof pool.curve25519 === 'object' && pool.curve25519 !== null ? pool.curve25519 : {}
      if (Object.keys(curve).length === 0) {
        const max = account.max_number_of_one_time_keys()
        account.generate_one_time_keys(Math.max(1, Math.min(this.oneTimeKeyTarget, max)))
        pool = parseOlmJson(account.one_time_keys(), 'one_time_keys')
      }
      const fresh: Record<string, any> = typeof pool.curve25519 === 'object' && pool.curve25519 !== null ? pool.curve25519 : {}
      const out: Record<string, unknown> = {}
      for (const [keyId, key] of Object.entries(fresh)) {
        if (typeof key !== 'string') continue
        const signedBody = { key }
        const signature = account.sign(canonicalJson(signedBody))
        out[`signed_curve25519:${keyId}`] = {
          key,
          signatures: { [userId]: { [`ed25519:${deviceId}`]: signature } },
        }
      }
      account.mark_keys_as_published()
      return Object.keys(out).length > 0 ? out : undefined
    } catch (error) {
      this.log(`matrix e2ee: one-time keys 组装失败: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** sync 后 one-time keys 水位低时的补充包（仅 one_time_keys 字段，同一 /keys/upload 端点）。 */
  topUpOneTimeKeys(deviceId: string, userId: string): Record<string, any> | undefined {
    if (this.account === undefined) return undefined
    const keys = this.collectOneTimeKeys(deviceId, userId)
    return keys === undefined ? undefined : { one_time_keys: keys }
  }

  /**
   * to-device `m.room_key` → 存 Megolm 入站会话。
   * issuer = 外层事件 sender（to-device 事件无独立 sender_key 位，用户 id 是可得的最强绑定）。
   * 返回 false = 形不对/算法不匹配/session_id 与 session_key 内嵌 id 不符（如实丢弃）。
   */
  handleRoomKey(content: unknown, issuerUserId = ''): boolean {
    if (!this.ready || this.olm === undefined) return false
    const raw = typeof content === 'object' && content !== null ? (content as Record<string, any>) : {}
    if (raw.algorithm !== MEGOLM_ALGORITHM) return false
    if (typeof raw.room_id !== 'string' || raw.room_id === '') return false
    if (typeof raw.session_id !== 'string' || raw.session_id === '') return false
    if (typeof raw.session_key !== 'string' || raw.session_key === '') return false
    try {
      const session = new this.olm.InboundGroupSession()
      const created = session.create(raw.session_key)
      // Megolm 文档：session_id 由 session_key 派生；绑定返回不一致即拒存（防伪造 key 事件）。
      if (typeof created === 'string' && created !== '' && created !== raw.session_id) {
        session.free?.()
        this.log(`matrix e2ee: m.room_key session_id 与会话密钥不符，已丢弃`)
        return false
      }
      this.sessions.set(this.sessionKey(raw.room_id, raw.session_id), {
        issuerUserId,
        senderKey: typeof raw.sender_key === 'string' ? raw.sender_key : '',
        session,
      })
      return true
    } catch (error) {
      this.log(`matrix e2ee: InboundGroupSession.create 失败: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  hasSession(roomId: string, sessionId: string): boolean {
    return this.sessions.has(this.sessionKey(roomId, sessionId))
  }

  sessionCount(): number {
    return this.sessions.size
  }

  /**
   * `m.room.encrypted`（Megolm）→ 被加密事件字段 `{type, content}`；任何失败回 undefined
   * （调用方按档位给占位，绝不伪称解密成功）。
   */
  decryptToEventFields(roomId: string, ev: MatrixEvent): { type?: string; content?: Record<string, any> } | undefined {
    const content = typeof ev.content === 'object' && ev.content !== null ? (ev.content as Record<string, any>) : {}
    if (content.algorithm !== MEGOLM_ALGORITHM) return undefined
    if (typeof content.session_id !== 'string' || typeof content.ciphertext !== 'string') return undefined
    const stored = this.sessions.get(this.sessionKey(roomId, content.session_id))
    if (stored === undefined) return undefined
    // sender 绑定：room_key 来源用户必须与加密事件 sender 一致（A 档可用的最强设备绑定面）。
    if (stored.issuerUserId !== '' && typeof ev.sender === 'string' && ev.sender !== '' && ev.sender !== stored.issuerUserId) {
      this.log(`matrix e2ee: ${roomId}/${content.session_id} sender 与密钥来源不符，按解密失败处理`)
      return undefined
    }
    if (stored.senderKey !== '' && typeof content.sender_key === 'string' && content.sender_key !== '' && content.sender_key !== stored.senderKey) {
      return undefined
    }
    try {
      const result = stored.session.decrypt(content.ciphertext)
      if (stored.senderKey === '' && typeof content.sender_key === 'string') stored.senderKey = content.sender_key
      const plain = parseOlmJson(result.plaintext, 'megolm plaintext')
      const type = typeof plain.type === 'string' ? plain.type : undefined
      const inner = typeof plain.content === 'object' && plain.content !== null ? (plain.content as Record<string, any>) : undefined
      if (type === undefined || inner === undefined) return undefined
      return { type, content: inner }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log(`matrix e2ee: Megolm 解密失败: ${this.lastError}`)
      return undefined
    }
  }

  /** 释放 WASM 会话对象（disconnect 用；Account 保留，重连仍可复用位由调用方决定）。 */
  freeSessions(): void {
    for (const stored of this.sessions.values()) stored.session.free?.()
    this.sessions.clear()
  }

  private sessionKey(roomId: string, sessionId: string): string {
    return `${roomId}|${sessionId}`
  }
}
