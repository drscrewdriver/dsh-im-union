/**
 * Matrix 渠道适配器（T3.2：Client-Server API v1.11 + olm E2EE 实验档，required/optional 两模式）。
 *
 * 净室口径：以下协议事实全部取自 matrix.org 公开规范独立重实现，未参考任何第三方
 * SDK（matrix-js-sdk / matrix-bot-sdk / matrix-nio）源码结构；运行时依赖为零
 * （Node≥22 全局 fetch，测试注入 fake fetch）。规范基线 v1.11，核对方式为
 * spec.matrix.org 公开规范检索快照（v1.10/v1.14/unstable 同族条款交叉印证）。
 *
 * 协议事实（https://spec.matrix.org/v1.11/client-server-api/）：
 * - 鉴权：所有 CS API 带 `Authorization: Bearer <access_token>`
 *   （/#authentication，v1.11 起 access token 走请求头而非查询参数）。
 *   本渠道只支持「预置 token 登录」面：config.homeserverBaseUrl + secrets.accessToken，
 *   password 登录（POST /login）不在本期范围。
 * - 身份实探：GET /_matrix/client/v3/account/whoami → `{user_id, device_id?}`
 *   （/#get_matrixclientv3accountwhoami）；user_id 用于丢弃自己的回声事件。
 * - 入站：GET /_matrix/client/v3/sync?since=<cursor>&timeout=30000&filter=<json>
 *   长轮询（/#get_matrixclientv3sync）：响应 `next_batch` 即下次 `since` 游标，
 *   游标非空才滚动；`since` 过旧被服务端清理时回 410 Gone，须弃游标重做全量同步。
 *   房间事件在 `rooms.join.<roomId>.timeline.events[]`，消息事件 type=`m.room.message`
 *   （msgtype m.text/m.notice/m.emote/m.image/m.file/m.audio/m.video），
 *   加密事件 type=`m.room.encrypted`（/#client-server-api-encryption-module）。
 *   filter 可为 JSON 串（限 room.timeline 类型与条数，见 SYNC_FILTER）。
 * - 邀请/加入：`rooms.invite` 内的房间需 POST /_matrix/client/v3/join/{roomIdOrAlias}
 *   才转为已加入（/#joiningroom）。
 * - 出站：PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}
 *   成功响应 `{event_id}`（/#put_matrixclientv3roomsroomidsendeventtypetxnid）。
 *   txnId 幂等语义（/#transaction-identifiers）：同一 device + 同一端点 + 同一 txnId
 *   被视为重传，homeserver 应返回与首次一致的结果（含 200 event_id）——所以
 *   **429 带 retry_after_ms 时按等待重试「同一 txnId」是协议明确许可的安全重试面**；
 *   其余网络断/5xx/成功但体不可解 = 结果不明（uncertain，引擎禁自动重发）。
 *   429 响应体 `{errcode:"M_LIMIT_EXCEEDED", error, retry_after_ms?}`，
 *   v1.10 起 `retry_after_ms` 让位于 `Retry-After` 头，两形态都读（/#error-codes）。
 * - 编辑流式：client 端编辑是标准能力（/#producing-event-edits）——后续事件带
 *   `"m.relates_to":{"rel_type":"m.replace","event_id":<原事件 id>}` + `m.new_content`，
 *   `body` 为纯文本回退（规范示例用 `* ` 前缀）；对「编辑的编辑」仍指向**原始事件 id**
 *   （聚合编辑语义）。无 olm 时不得把编辑发进加密房间（见 E2EE 档位）。
 * - typing：PUT /_matrix/client/v3/rooms/{roomId}/typing 体
 *   `{typing:true, timeout:<ms>}`（/#typing-notifications；路径里的 userId 自 v1.1 废弃）。
 * - 加密判定：GET /_matrix/client/v3/rooms/{roomId}/state/m.room.encryption 有
 *   `algorithm` 即该房间已启用 Megolm（未启用回 404 M_NOT_FOUND，
 *   /#get_matrixclientv3roomsroomidstateeventtypestatekey）。
 * - 成员面：GET /_matrix/client/v3/rooms/{roomId}/members → `chunk[]` 内
 *   `m.room.member` 事件（state_key=用户 id，content.membership/displayname，
 *   /#get_matrixclientv3roomsroomidmembers）。
 * - 回复回退（/#handling-replies）：`content["m.relates_to"]["m.in_reply_to"].event_id`
 *   为被回复事件 id，`body` 前缀是以 `> ` 起始、以单独一行 `> ` 收尾的引用块——
 *   客户端须剥离回退块再展示正文。
 * - 长度：联邦事件体量上限 65536 字节，本实现按任务口径保守取 4000 字符分段（引擎分段）。
 *
 * E2EE 诚实档位（本期核心约束）：olm WASM 解密库不在本包依赖内（宿主侧后接），
 * 因此绝不在无解密面时伪称 E2EE——
 * - `encryption='optional'`（默认）：加密事件（type=`m.room.encrypted`）投递
 *   占位文案 `[加密消息：E2EE 解密面未接]`，不丢事件（回合可见「有消息但解不开」）；
 * - `encryption='required'`：connect 期（首轮 sync 房间面）对每个房间探
 *   `m.room.encryption` 状态，已加密且无解密面 → **明确拒连该房间**（不消费其事件、
 *   邀请面 invite_state 声明加密则不 join、出站亦本地拒发），诊断项 `e2ee` 报
 *   failed 并带原因；探测结果不明时不判死（报 unverified）。
 *
 * dm/group 判定口径（简化，注释即规范）：config.dmRoomList 命中即 dm；否则取
 * `GET /rooms/{roomId}/members` 的 join 成员数，≤2 判 dm、>2 判 group，判定失败
 * 保守按 group（未点名不响应，红线 D6 不越权）；群内 mentionedBot = 文本含本 bot
 * 的 user_id 或已缓存 displayname，或 `m.in_reply_to` 指向本 bot 自己发出的事件。
 *
 * Receipt 语义：平台接受（拿到 event_id）≠ 已送达；uncertain=true 时引擎禁自动重发。
 * authorize() 恒返回 undefined——私聊准入裁决在网关白名单（红线 D6），渠道不越权。
 * 生命周期：disconnect 只软停轮询，不发 POST /logout（那会吊销外部预置的 token 本身）。
 */
import type { ChatAddress, ChatKind } from '../engine/router.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  OutboundFile,
  Receipt,
  ReplyStream,
  SemanticMessage,
} from './types.js'
import { FILE_BUDGET } from '../engine/files.js'

/** E2EE 档位：optional=加密房间降级占位；required=加密房间拒连。 */
export type MatrixE2eeMode = 'optional' | 'required'

const DEFAULT_SYNC_TIMEOUT_MS = 30_000
/** 编辑流式节流：Matrix 速率限制按设备桶，留 1.1s 余量（与 telegram/slack 同档）。 */
const DEFAULT_EDIT_THROTTLE_MS = 1_100
const TYPING_TIMEOUT_MS = 20_000
/** 任务口径：65536 字节事件上限保守折算，正文取 4000 字符。 */
export const MATRIX_MAX_MESSAGE = 4_000
/** 429 同一 txnId 的安全重试上限与单次等待封顶（超封顶=确定性拒绝）。 */
const MAX_429_ATTEMPTS = 3
const MAX_RATE_LIMIT_WAIT_MS = 5_000
const POLL_BACKOFF_MAX_MS = 30_000
/** 成功轮间最小间隔：防不 hold 的服务端把轮询打成热循环。 */
const POLL_MIN_INTERVAL_MS = 200
/** 环形排重上限（sync 重投 / 410 重建游标时的幂等面）。 */
const SEEN_EVENT_LIMIT = 1_000
const SELF_EVENT_LIMIT = 2_000

/** 无解密面时的占位文案（协议事实：m.room.encrypted 在本包不可解）。 */
export const ENCRYPTED_PLACEHOLDER = '[加密消息：E2EE 解密面未接]'

/**
 * 时间线事件 → 可下载的明文 m.file content（编辑取 m.new_content）；
 * 非 m.file / 加密附件（file 带 key|iv）返回 undefined。
 */
function plainFileContent(ev: MatrixEvent | undefined): Record<string, any> | undefined {
  if (ev === undefined || ev.type !== 'm.room.message') return undefined
  const content = asRecord(ev.content)
  const relates = asRecord(content['m.relates_to'])
  const effective = relates.rel_type === 'm.replace' ? asRecord(content['m.new_content']) : content
  if (effective.msgtype !== 'm.file') return undefined
  const fileObj = asRecord(effective.file)
  if (fileObj.key !== undefined || fileObj.iv !== undefined) return undefined
  return effective
}
/** 非文本 msgtype 占位文案（m.file 另有下载面 → 文本仅做可读标注）。 */
const NON_TEXT_PLACEHOLDER: Record<string, string> = {
  'm.image': '[图片消息：媒体下载面未接]',
  'm.file': '[文件消息]',
  'm.audio': '[语音消息：媒体下载面未接]',
  'm.video': '[视频消息：媒体下载面未接]',
}

/** sync filter（JSON 串形态，协议允许直接内联）：只取消息/加密/成员事件，限条数。 */
const SYNC_FILTER = {
  room: {
    timeline: { limit: 20, types: ['m.room.message', 'm.room.encrypted', 'm.room.member'] },
    state: { lazy_load_members: true },
  },
}
const SYNC_FILTER_JSON = JSON.stringify(SYNC_FILTER)

interface MatrixFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer?(): Promise<ArrayBuffer>
  headers?: { get(name: string): string | null }
}
interface RequestInitLike {
  method?: string
  body?: string | Uint8Array
  headers?: Record<string, string>
  signal?: AbortSignal
}
/** 可注入的 fetch 形态（只声明用到的能力）。 */
export type FetchLike = (url: string, init?: RequestInitLike) => Promise<MatrixFetchResponse>

/** Matrix 线事件（宽松形：时间线/状态/成员共用一套字段）。 */
export interface MatrixEvent {
  type?: string
  event_id?: string
  sender?: string
  origin_server_ts?: number
  state_key?: string
  content?: Record<string, any>
}

export interface MatrixAdapterOptions {
  /** 预置 access token（secret 面）。 */
  accessToken: string
  /** homeserver 根地址，形如 https://matrix.example.org（无尾斜杠）。 */
  homeserverBaseUrl: string
  /** E2EE 档位，缺省 optional。 */
  encryption?: MatrixE2eeMode
  /** 强制按 dm 处理的房间 id 列表（简化私聊判定）。 */
  dmRoomList?: string[]
  /** sync 长轮询超时 ms，缺省 30000。 */
  syncTimeoutMs?: number
  /** 编辑流式节流 ms，缺省 1100（测试可置 0）。 */
  editThrottleMs?: number
  /** 全量首 sync 是否投递历史时间线，缺省 false（防回放旧消息触发回合）。 */
  deliverInitialHistory?: boolean
  /** 测试注入点；缺省用全局 fetch。 */
  fetchImpl?: FetchLike
  logger?: (msg: string) => void
}

/** 确定性失败（4xx / 协议可判的拒绝）：引擎可如实告知用户，不自动重发。 */
export class MatrixApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errcode: string,
  ) {
    super(message)
  }
}
/** 结果不明（网络断/5xx/成功体不可解）：D7 禁自动重发。 */
export class MatrixUncertainError extends Error {}

export class MatrixAdapter implements ChannelAdapter {
  readonly id = 'matrix'
  readonly label = 'Matrix'
  readonly caps: ChannelCaps = {
    /** client 端编辑（m.replace + m.new_content）是标准能力 → 编辑流式成立 */
    editStream: true,
    /** 无原生流式接口（Matrix 只有事件聚合编辑） */
    nativeStream: false,
    /** 无原生按钮（本期不接 client-side buttons / m.new_content 之外的交互面） */
    nativeChoices: false,
    /** 未接 m.reaction 注解关系 */
    statusReaction: false,
    /** PUT /rooms/{roomId}/typing 公开 API */
    typing: true,
    /** 媒体下载面只接了 m.file（m.image 仍不拉字节） */
    imageIn: false,
    fileIn: true,
    fileOut: true,
    /** 未接 thread 关系（m.thread） */
    threads: false,
    voice: false,
    maxMessageLength: MATRIX_MAX_MESSAGE,
  }

  connected = false
  private readonly accessToken: string
  private readonly base: string
  private readonly e2eeMode: MatrixE2eeMode
  private readonly fetchImpl: FetchLike
  private readonly log: (msg: string) => void
  private readonly syncTimeoutMs: number
  private readonly editThrottleMs: number
  private readonly dmRoomList: string[]
  private readonly deliverInitialHistory: boolean

  private listeners: MessageListener[] = []
  private pollController: AbortController | undefined
  /** sync 游标（next_batch）；非空才滚动。 */
  private nextBatch = ''
  private userId = ''
  private txnSeq = 0

  private readonly roomKinds = new Map<string, ChatKind>()
  private readonly roomEncrypted = new Map<string, boolean>()
  /** roomId → 拒连原因（required 模式）。 */
  private readonly rejectedRooms = new Map<string, string>()
  private readonly displayNames = new Map<string, string>()
  /** 本 bot 自己发出的事件 id（回复即点名的判据）。 */
  private readonly selfEventIds = new Set<string>()
  private readonly seenEventIds = new Set<string>()
  private readonly joinedInvites = new Set<string>()
  /** 加密状态探测出现过不确定结果（诊断据此报 unverified，不判死）。 */
  private e2eeProbeUncertain = false

  constructor(options: MatrixAdapterOptions) {
    if (typeof options.accessToken !== 'string' || options.accessToken === '') {
      throw new Error('matrix: accessToken 缺失（预置 token 登录面，需由凭据库提供）')
    }
    if (typeof options.homeserverBaseUrl !== 'string' || options.homeserverBaseUrl === '') {
      throw new Error('matrix: homeserverBaseUrl 缺失（形如 https://matrix.example.org）')
    }
    this.accessToken = options.accessToken
    this.base = options.homeserverBaseUrl.replace(/\/+$/, '')
    this.e2eeMode = options.encryption ?? 'optional'
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike)
    this.log = options.logger ?? (() => {})
    this.syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS
    this.editThrottleMs = options.editThrottleMs ?? DEFAULT_EDIT_THROTTLE_MS
    this.dmRoomList = options.dmRoomList ?? []
    this.deliverInitialHistory = options.deliverInitialHistory ?? false
  }

  /** required 模式下已被拒连的房间 id（诊断/测试可见）。 */
  get refusedRoomIds(): string[] {
    return [...this.rejectedRooms.keys()]
  }

  /** 已建立的 sync 游标是否存在（不泄漏游标内容）。 */
  get hasSyncCursor(): boolean {
    return this.nextBatch !== ''
  }

  // —— 生命周期 ——————————————————————————————————

  async connect(signal?: AbortSignal): Promise<void> {
    const who = await this.requestJson<{ user_id?: unknown }>('GET', '/_matrix/client/v3/account/whoami', { signal })
    if (typeof who.user_id !== 'string' || who.user_id === '') {
      throw new Error('matrix: whoami 响应缺少 user_id（homeserver 非规范实现？）')
    }
    this.userId = who.user_id
    this.connected = true
    this.pollController = new AbortController()
    const link = this.pollController.signal
    const onAbort = (): void => this.pollController?.abort()
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true })
      this.externalAbortCleanup = () => signal.removeEventListener('abort', onAbort) // disconnect 後必须摘除，防重连累积
    }
    // connect 期跑一轮 sync：建游标 + 房间面（required 模式在此拒连加密房间、邀请在此自动 join）
    await this.syncOnce(link)
    void this.pollLoop(link)
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.externalAbortCleanup?.()
    this.externalAbortCleanup = undefined
    this.pollController?.abort()
  }
  private externalAbortCleanup: (() => void) | undefined

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000
    let lastRoundEnd = Date.now()
    while (!signal.aborted && this.connected) {
      // 循环头统一间隔：含 connect 首轮 sync——防不 hold 的服务端把成功路径打成热循环。
      const gap = POLL_MIN_INTERVAL_MS - (Date.now() - lastRoundEnd)
      if (gap > 0) await sleep(gap)
      try {
        await this.syncOnce(signal)
        backoffMs = 1_000
      } catch (error) {
        if (signal.aborted || !this.connected) return
        if ((error as Error).name === 'AbortError') return
        this.log(`matrix sync 失败，${backoffMs}ms 后重试: ${describe(error)}`)
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_MAX_MS)
      }
      lastRoundEnd = Date.now()
    }
  }

  // —— 入站 sync 面 ——————————————————————————————————

  /**
   * 一轮 sync：滚动游标、消费 rooms.join 时间线、自动 join 邀请房间。
   * 全量首批（无 since）默认只建游标与房间面，不回放历史时间线（见 options）。
   */
  private async syncOnce(signal?: AbortSignal): Promise<void> {
    const incremental = this.nextBatch !== ''
    const params = new URLSearchParams()
    if (incremental) params.set('since', this.nextBatch)
    params.set('timeout', String(this.syncTimeoutMs))
    params.set('filter', SYNC_FILTER_JSON)
    let json: Record<string, any>
    try {
      json = await this.requestJson<Record<string, any>>('GET', `/_matrix/client/v3/sync?${params.toString()}`, {
        signal,
        retryOn429: true,
      })
    } catch (error) {
      // 410 Gone：since 过旧被清理 → 弃游标，下一轮重做全量同步（协议事实）
      if (error instanceof MatrixApiError && error.status === 410) {
        this.nextBatch = ''
        this.log('matrix sync 游标过期（410），已重置为全量同步')
        return
      }
      throw error
    }
    if (typeof json.next_batch === 'string' && json.next_batch !== '') this.nextBatch = json.next_batch
    const rooms = asRecord(json.rooms)
    const invite = asRecord(rooms.invite)
    for (const roomId of Object.keys(invite)) {
      await this.acceptInvite(roomId, asRecord(invite[roomId]), signal)
    }
    const deliver = incremental || this.deliverInitialHistory
    const joined = asRecord(rooms.join)
    for (const [roomId, roomRaw] of Object.entries(joined)) {
      if (this.rejectedRooms.has(roomId)) continue
      const room = asRecord(roomRaw)
      this.rememberStateNames(room)
      if (this.e2eeMode === 'required' && (await this.isRoomEncrypted(roomId, signal))) {
        this.rejectedRooms.set(roomId, '房间已启用 m.megolm 加密，本包无 olm 解密面（required 模式拒连）')
        this.log(`matrix: 拒连加密房间 ${roomId}`)
        continue
      }
      await this.resolveKind(roomId, signal)
      if (!deliver) continue
      const timeline = asRecord(room.timeline)
      const events = Array.isArray(timeline.events) ? (timeline.events as MatrixEvent[]) : []
      for (const ev of events) {
        if (typeof ev.event_id === 'string') {
          if (this.seenEventIds.has(ev.event_id)) continue
          this.rememberSeen(ev.event_id)
        }
        const message = this.normalizeEvent(roomId, ev)
        if (message === undefined) continue
        // 异步 fill 范式：m.file 先拉字节再投递（失败只降级，不丢整条消息）。
        const fileContent = plainFileContent(ev)
        if (fileContent !== undefined) await this.fillFiles(message, fileContent)
        for (const listener of this.listeners) listener(message)
      }
    }
  }

  /** 邀请房间：connect 后自动 join；required 模式下 invite_state 声明加密则不 join。 */
  private async acceptInvite(roomId: string, invite: Record<string, any>, signal?: AbortSignal): Promise<void> {
    if (this.joinedInvites.has(roomId) || this.rejectedRooms.has(roomId)) return
    this.joinedInvites.add(roomId)
    if (this.e2eeMode === 'required') {
      const events = Array.isArray(asRecord(invite.invite_state).events) ? (asRecord(invite.invite_state).events as MatrixEvent[]) : []
      if (events.some((ev) => ev.type === 'm.room.encryption')) {
        this.rejectedRooms.set(roomId, '邀请面 invite_state 已声明 m.room.encryption，本包无 olm 解密面（required 模式拒连）')
        this.log(`matrix: 拒绝加入加密邀请房间 ${roomId}`)
        return
      }
    }
    try {
      await this.requestJson('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, { signal, retryOn429: true })
    } catch (error) {
      if (error instanceof MatrixApiError && error.status === 403) {
        this.log(`matrix: 加入 ${roomId} 被拒（403，需邀请权限）`)
        return
      }
      // 网络类失败：回滚记账，下一轮 sync 可重试 join（否则邀请被静默丢弃）。
      this.joinedInvites.delete(roomId)
      this.log(`matrix: join ${roomId} 失败（下轮重试）: ${describe(error)}`)
    }
  }

  /** 房间是否已启用加密（required 模式用）：state 有 algorithm 即加密，404 即明文。 */
  private async isRoomEncrypted(roomId: string, signal?: AbortSignal): Promise<boolean> {
    const known = this.roomEncrypted.get(roomId)
    if (known !== undefined) return known
    try {
      const state = await this.requestJson<Record<string, any>>(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
        { signal, retryOn429: true },
      )
      const encrypted = typeof state.algorithm === 'string'
      this.roomEncrypted.set(roomId, encrypted)
      return encrypted
    } catch (error) {
      if (error instanceof MatrixApiError && error.status === 404) {
        this.roomEncrypted.set(roomId, false)
        return false
      }
      // 探测不明：required 模式 fail-closed——无法证明非加密就拒连该房间
      //（明文泄漏风险重于误拒；主会话缺陷登记修正，探测结果负缓存防每轮重探）。
      this.e2eeProbeUncertain = true
      this.roomEncrypted.set(roomId, true)
      this.log(`matrix: 房间 ${roomId} 加密状态探测不明，required 模式按拒连处理: ${describe(error)}`)
      return true
    }
  }

  /** dm/group 判定：dmRoomList 命中即 dm，否则 join 成员数 ≤2 判 dm；判定失败保守按 group。 */
  private async resolveKind(roomId: string, signal?: AbortSignal): Promise<ChatKind> {
    const cached = this.roomKinds.get(roomId)
    if (cached !== undefined) return cached
    if (this.dmRoomList.includes(roomId)) {
      this.roomKinds.set(roomId, 'dm')
      return 'dm'
    }
    let kind: ChatKind = 'group'
    try {
      const members = await this.requestJson<Record<string, any>>(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`,
        { signal, retryOn429: true },
      )
      const chunk = Array.isArray(members.chunk) ? (members.chunk as MatrixEvent[]) : []
      const joined = new Set<string>()
      for (const ev of chunk) {
        if (ev.type !== 'm.room.member' || typeof ev.state_key !== 'string') continue
        const content = asRecord(ev.content)
        if (typeof content.displayname === 'string') this.displayNames.set(ev.state_key, content.displayname)
        if (content.membership === 'join') joined.add(ev.state_key)
      }
      kind = joined.size === 2 ? 'dm' : 'group' // 0/1/空 chunk=成员面不全，保守 group（防群误判 dm 绕 D6）
    } catch (error) {
      this.log(`matrix: 房间 ${roomId} 成员数探测失败，保守按 group: ${describe(error)}`)
    }
    this.roomKinds.set(roomId, kind)
    return kind
  }

  /** 从 sync 携带的房间状态/时间线事件里补 displayname 缓存（零额外请求）。 */
  private rememberStateNames(room: Record<string, any>): void {
    const events = Array.isArray(asRecord(room.state).events) ? (asRecord(room.state).events as MatrixEvent[]) : []
    const timeline = Array.isArray(asRecord(room.timeline).events) ? (asRecord(room.timeline).events as MatrixEvent[]) : []
    for (const ev of [...events, ...timeline]) {
      if (ev.type !== 'm.room.member' || typeof ev.state_key !== 'string') continue
      const name = asRecord(ev.content).displayname
      if (typeof name === 'string' && name !== '') this.displayNames.set(ev.state_key, name)
    }
  }

  /**
   * 线事件 → SemanticMessage（公开归一半，供单测直验）。
   * 丢弃口径：非消息/加密事件、缺 sender、自己的回声（sender === whoami user_id）。
   */
  normalizeEvent(roomId: string, ev: MatrixEvent | undefined): SemanticMessage | undefined {
    if (ev === undefined || typeof ev.type !== 'string') return undefined
    if (ev.type !== 'm.room.message' && ev.type !== 'm.room.encrypted') return undefined
    if (typeof ev.sender !== 'string' || ev.sender === '') return undefined
    if (this.userId !== '' && ev.sender === this.userId) return undefined // 回声丢弃
    // 未判定房间保守按 group（未点名不响应，红线 D6）
    const kind = this.roomKinds.get(roomId) ?? 'group'
    const address: ChatAddress = { channel: 'matrix', kind, chatId: roomId }
    const semantic: SemanticMessage = {
      address,
      userId: ev.sender,
      userDisplayName: this.displayNameOf(ev.sender),
      text: '',
      mentionedBot: false,
      timestamp: typeof ev.origin_server_ts === 'number' ? ev.origin_server_ts : undefined,
    }
    const content = asRecord(ev.content)
    if (ev.type === 'm.room.encrypted') {
      // required 模式已在上游拒连整个房间；此处是双保险（不伪称解密成功）
      if (this.e2eeMode === 'required') return undefined
      semantic.text = ENCRYPTED_PLACEHOLDER
      return semantic
    }
    const relates = asRecord(content['m.relates_to'])
    const isEdit = relates.rel_type === 'm.replace' && typeof relates.event_id === 'string'
    const effective = isEdit ? asRecord(content['m.new_content']) : content
    const msgtype = typeof effective.msgtype === 'string' ? effective.msgtype : typeof content.msgtype === 'string' ? content.msgtype : ''
    if (msgtype !== 'm.text' && msgtype !== 'm.notice' && msgtype !== 'm.emote') {
      semantic.text = NON_TEXT_PLACEHOLDER[msgtype] ?? `[暂不支持的消息类型: ${msgtype === '' ? 'unknown' : msgtype}]`
      return semantic // 非文本内容不可判点名 → 群内不算点名
    }
    let text = typeof effective.body === 'string' ? effective.body : typeof content.body === 'string' ? content.body : ''
    const replyRef = asRecord(relates['m.in_reply_to'])
    if (typeof replyRef.event_id === 'string') {
      const stripped = stripReplyFallback(text)
      text = stripped.text
      if (stripped.quote !== undefined) semantic.quoteText = stripped.quote
      // 协议事实：回复目标在 m.in_reply_to.event_id（早前误用 relates.event_id=编辑位，永不命中）
      if (this.selfEventIds.has(replyRef.event_id)) semantic.mentionedBot = true
    }
    semantic.text = text
    if (kind === 'group') semantic.mentionedBot = semantic.mentionedBot || this.detectMention(text)
    return semantic
  }

  /** 群内点名判据：文本含本 bot user_id / 已缓存 displayname（私聊不依赖此位）。 */
  private detectMention(text: string): boolean {
    if (text === '') return false
    const lower = text.toLowerCase()
    if (this.userId !== '' && lower.includes(this.userId.toLowerCase())) return true
    const ownName = this.userId !== '' ? this.displayNames.get(this.userId) : undefined
    if (ownName !== undefined && ownName !== '' && lower.includes(ownName.toLowerCase())) return true
    return false
  }

  private displayNameOf(userId: string): string {
    const cached = this.displayNames.get(userId)
    if (cached !== undefined && cached !== '') return cached
    const local = userId.startsWith('@') ? userId.slice(1).split(':')[0] ?? userId : userId
    return local === '' ? userId : local
  }

  // —— 出站 ——————————————————————————————————————

  /** txnId：时间戳 + 单调递增（规范推荐形态），同一设备内唯一。 */
  private nextTxnId(): string {
    this.txnSeq += 1
    return `imu-${Date.now().toString(36)}-${this.txnSeq.toString(36)}`
  }

  /** required 模式守卫：已知加密房间一律本地拒发（明文不得进加密房间）。 */
  private assertRoomSendable(roomId: string): void {
    const refused = this.rejectedRooms.has(roomId) || this.roomEncrypted.get(roomId) === true
    if (this.e2eeMode === 'required' && refused) {
      throw new MatrixApiError(
        `matrix: E2EE required 模式拒连加密房间 ${roomId}（本包无 olm 加解密面，不伪称 E2EE）`,
        403,
        'IMU_E2EE_REFUSED',
      )
    }
  }

  /**
   * PUT /rooms/{roomId}/send/m.room.message/{txnId}。
   * 返回 event_id（可能为空——服务端 200 但无体的形态按「已接受但无 id」处理）。
   */
  private async sendEvent(roomId: string, content: Record<string, unknown>, signal?: AbortSignal): Promise<string | undefined> {
    this.assertRoomSendable(roomId)
    const txnId = this.nextTxnId()
    const json = await this.requestJson<Record<string, any>>(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      { body: content, signal, retryOn429: true },
    )
    const eventId = typeof json.event_id === 'string' ? json.event_id : undefined
    if (eventId !== undefined) this.rememberSelfEvent(eventId)
    return eventId
  }

  /** 编辑事件：m.replace 指向原始事件 id，m.new_content 为新内容，body 为 `* ` 回退。 */
  private async sendEdit(roomId: string, originalEventId: string, text: string, signal?: AbortSignal): Promise<string | undefined> {
    const max = this.caps.maxMessageLength
    const body = truncate(text, max)
    return this.sendEvent(
      roomId,
      {
        msgtype: 'm.text',
        // 回退体（不支持编辑的老客户端看到的原文）同样受长度上限约束
        body: `* ${truncate(text, max - 2)}`,
        'm.new_content': { msgtype: 'm.text', body },
        'm.relates_to': { rel_type: 'm.replace', event_id: originalEventId },
      },
      signal,
    )
  }

  /** 纯文本投递（本期不做 markdown→HTML 的 formatted_body 转换，不伪造富文本）。 */
  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const eventId = await this.sendEvent(
      address.chatId,
      { msgtype: 'm.text', body: truncate(text, this.caps.maxMessageLength) },
      signal,
    )
    return eventId === undefined ? { uncertain: false } : { platformMessageId: eventId, uncertain: false }
  }

  /**
   * 文件回传（公开 REST，规范 v1.9 §Media Repository）：
   * 1) POST /_matrix/media/v3/upload?filename=… （原始字节 + Content-Type）→ {content_uri: mxc://}
   *    https://spec.matrix.org/v1.9/client-server-api/#post_matrixmediav3upload
   * 2) PUT /rooms/{roomId}/send/m.room.message/{txnId} 发 m.file 事件
   *    （body=文件名、url=mxc、file={url,mimetype,size} 为 OEP-0008 新形）。
   * 判型沿用 requestJson 口径：网络/5xx/体不可解 → uncertain（D7 禁重发，
   * 上传与发送任一步结果不明都不能盲重传，否则会投两条）；其余非 2xx → MatrixApiError。
   */
  async sendFile(address: ChatAddress, file: OutboundFile, signal?: AbortSignal): Promise<Receipt> {
    const path = `/_matrix/media/v3/upload?filename=${encodeURIComponent(file.name)}`
    let response: MatrixFetchResponse
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': file.mimeType ?? 'application/octet-stream',
        },
        body: file.data,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      throw new MatrixUncertainError(`matrix POST /_matrix/media/v3/upload: 网络异常 ${describe(error)}，结果不明`)
    }
    if (response.status >= 500) throw new MatrixUncertainError(`matrix POST /_matrix/media/v3/upload: HTTP ${response.status}`)
    if (!response.ok) {
      const payload = await readJson(response)
      const errcode = typeof payload?.errcode === 'string' ? payload.errcode : ''
      throw new MatrixApiError(
        `matrix POST /_matrix/media/v3/upload: ${errcode === '' ? `HTTP ${response.status}` : `${errcode} ${String(payload?.error ?? '')}`}`,
        response.status,
        errcode,
      )
    }
    const uploaded = await readJson(response)
    const contentUri = typeof uploaded?.content_uri === 'string' ? uploaded.content_uri : ''
    if (!contentUri.startsWith('mxc://')) {
      throw new MatrixApiError('matrix POST /_matrix/media/v3/upload: 成功体缺 content_uri', response.status, 'IMU_NO_CONTENT_URI')
    }
    const eventId = await this.sendEvent(
      address.chatId,
      {
        msgtype: 'm.file',
        body: file.name,
        url: contentUri,
        file: { url: contentUri, mimetype: file.mimeType ?? 'application/octet-stream', size: file.data.byteLength },
      },
      signal,
    )
    return eventId === undefined ? { uncertain: false } : { platformMessageId: eventId, uncertain: false }
  }

  /** mxc://serverName/mediaId → 下载路径（v1.11 起媒体走 client 而非 media 域）。 */
  private mediaDownloadPath(mxc: string): string | undefined {
    const matched = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc)
    if (matched === null) return undefined
    return `/_matrix/client/v1/media/download/${encodeURIComponent(matched[1])}/${encodeURIComponent(matched[2])}`
  }

  /**
   * 入站 m.file 字节下载：GET /_matrix/client/v1/media/download/{serverName}/{mediaId}（带 Bearer）。
   * 加密附件（file.key 在位）无 olm 面 → 只记日志降级；限额跟引擎 FILE_BUDGET。
   */
  private async fillFiles(message: SemanticMessage, content: Record<string, any>): Promise<void> {
    const name = typeof content.body === 'string' && content.body !== '' ? content.body : 'matrix-file'
    const fileObj = asRecord(content.file)
    const mxc = typeof content.url === 'string' ? content.url : typeof fileObj.url === 'string' ? fileObj.url : ''
    if (fileObj.key !== undefined || fileObj.iv !== undefined) {
      // 加密附件（OEP-3 形：file 带 key/iv）无 olm 解密面 → 不伪称可用
      this.log(`matrix: 加密附件未接解密，降级为无附件：${name}`)
      return
    }
    if (mxc === '') {
      this.log(`matrix: m.file 无 mxc 地址，降级为无附件：${name}`)
      return
    }
    if (typeof content.size === 'number' && content.size > FILE_BUDGET.perFileMaxBytes) {
      this.log(`matrix: 文件超 20 MiB 上限，未下载：${name}`)
      return
    }
    const path = this.mediaDownloadPath(mxc)
    if (path === undefined) {
      this.log(`matrix: mxc 地址形不可解，降级为无附件：${mxc}`)
      return
    }
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.accessToken}` },
      })
      if (!response.ok || response.arrayBuffer === undefined) {
        this.log(`matrix: 媒体下载被拒（HTTP ${response.status}），降级为无附件：${name}`)
        return
      }
      const data = new Uint8Array(await response.arrayBuffer())
      if (data.byteLength === 0) this.log(`matrix: 媒体下载为空，降级为无附件：${name}`)
      else message.files = [{ name, data }]
    } catch (error) {
      this.log(`matrix: 媒体下载失败（${describe(error)}），降级为无附件：${name}`)
    }
  }

  /**
   * 编辑流式：首发取 event_id 作为原始事件，后续 update 以 m.replace 编辑同一条。
   * 确定性拒绝（权限/事件被删）→ 补发新消息接替；结果不明 → 上抛（引擎不盲重试）。
   */
  async beginStream(address: ChatAddress, signal?: AbortSignal): Promise<ReplyStream> {
    let originalEventId: string | undefined
    let lastEditAt = 0
    let pending: Promise<void> = Promise.resolve()
    let aborted = false
    const send = async (text: string): Promise<void> => {
      originalEventId = await this.sendEvent(
        address.chatId,
        { msgtype: 'm.text', body: truncate(text, this.caps.maxMessageLength) },
        signal,
      )
    }
    const edit = async (text: string): Promise<void> => {
      if (originalEventId === undefined) return send(text)
      const target = originalEventId
      try {
        await this.sendEdit(address.chatId, target, text, signal)
      } catch (error) {
        if (error instanceof MatrixUncertainError) throw error
        if (error instanceof MatrixApiError && error.errcode === 'IMU_E2EE_REFUSED') throw error
        // 编辑被服务端确定性拒绝 → 补发新消息接替（宁可多发不丢）
        await send(text)
      }
    }
    const queued = (text: string): Promise<void> => {
      const run = async (): Promise<void> => {
        if (aborted) return
        const wait = this.editThrottleMs - (Date.now() - lastEditAt)
        if (wait > 0) await sleep(wait)
        lastEditAt = Date.now()
        await edit(text)
      }
      // 链体不带毒：前一次失败后照常执行本拍（否则一个 uncertain 永久毒化整条流，
      // finish 永远拿不到 Receipt）；本拍错误仍如实上抛给调用方。
      const current = pending.then(run, run)
      pending = current.catch(() => undefined)
      return current
    }
    return {
      async update(markdown: string): Promise<void> {
        await queued(markdown)
      },
      async finish(markdown: string): Promise<Receipt> {
        await queued(markdown)
        return originalEventId === undefined
          ? { uncertain: false }
          : { platformMessageId: originalEventId, uncertain: false }
      },
      abort(): void {
        aborted = true
      },
    }
  }

  async setTyping(address: ChatAddress): Promise<void> {
    try {
      await this.requestJson(
        'PUT',
        `/_matrix/client/v3/rooms/${encodeURIComponent(address.chatId)}/typing`,
        { body: { typing: true, timeout: TYPING_TIMEOUT_MS } },
      )
    } catch (error) {
      if (error instanceof MatrixUncertainError) return // 结果不明不打断回合
      this.log(`matrix typing 失败: ${describe(error)}`)
    }
  }

  /** 私聊准入恒交网关白名单（红线 D6），群 @ 由网关裁决——渠道不越权。 */
  authorize(): boolean | undefined {
    return undefined
  }

  /**
   * 诊断三态：token 实探 whoami（hint 只回显 user_id，零 token）；sync 连通位；
   * e2ee 档位面；roundtrip 恒 unverified（需真机在客户端发消息）。
   */
  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    const start = Date.now()
    try {
      const who = await this.requestJson<Record<string, any>>('GET', '/_matrix/client/v3/account/whoami', { signal })
      checks.push({
        name: 'token-valid',
        status: 'passed',
        hint: typeof who.user_id === 'string' ? who.user_id : undefined,
        elapsedMs: Date.now() - start,
      })
    } catch (error) {
      const uncertain = error instanceof MatrixUncertainError
      checks.push({
        name: 'token-valid',
        status: uncertain ? 'unverified' : 'failed',
        hint: uncertain ? '网络结果不明，未据此判死' : 'access token 无效或已吊销（M_UNKNOWN_TOKEN）',
        elapsedMs: Date.now() - start,
      })
    }
    checks.push({
      name: 'sync',
      status: this.connected && this.nextBatch !== '' ? 'passed' : 'unverified',
      hint: this.connected
        ? `已观测房间 ${this.roomKinds.size} 个，游标已滚动${this.rejectedRooms.size > 0 ? `（拒连 ${this.rejectedRooms.size} 个）` : ''}`
        : '未连接',
    })
    if (this.e2eeMode === 'required') {
      const refused = [...this.rejectedRooms.entries()]
      if (refused.length > 0) {
        checks.push({
          name: 'e2ee',
          status: 'failed',
          hint: `required 模式已拒连 ${refused.length} 个加密房间（olm 解密面未接）：${refused.map(([id, why]) => `${id} ${why}`).join('；')}`.slice(0, 300),
        })
      } else if (this.e2eeProbeUncertain) {
        checks.push({ name: 'e2ee', status: 'unverified', hint: '加密状态探测结果不明（未据此判死）' })
      } else {
        checks.push({ name: 'e2ee', status: 'passed', hint: 'required 模式：未检出已启用加密的房间' })
      }
    } else {
      checks.push({
        name: 'e2ee',
        status: 'unverified',
        hint: 'optional 模式：olm 解密面未接，加密房间按占位文案降级（不伪称 E2EE）',
      })
    }
    checks.push({
      name: 'roundtrip',
      status: 'unverified',
      hint: '真实收发 round-trip 需真机验证（Matrix 客户端在本 bot 所在房间发消息）',
    })
    checks.push({
      // 上传/下载 REST 面已接，但 homeserver 可能禁用媒体仓储（M_UNKNOWN/404）或
      // 要求认证下载域 → 未实证即 unverified，不谎报 passed。
      name: 'file-surface',
      status: 'unverified',
      hint: '媒体上传 POST /_matrix/media/v3/upload + 下载 GET /_matrix/client/v1/media/download 需 homeserver 实探',
    })
    return checks
  }

  // —— HTTP 面 ——————————————————————————————————————

  /**
   * 统一 REST 面：网络断/5xx/成功体不可解 → MatrixUncertainError；
   * 其余非 2xx → MatrixApiError（确定性，含 errcode）。
   * retryOn429 时按 retry_after_ms（或 Retry-After 头）等待后重试**同一请求**——
   * 对 PUT send 而言即同一 txnId（协议许可的幂等重传面）。
   */
  private async requestJson<T = Record<string, any>>(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    options: { body?: unknown; signal?: AbortSignal; retryOn429?: boolean } = {},
  ): Promise<T> {
    const url = `${this.base}${path}`
    const maxAttempts = options.retryOn429 === true ? MAX_429_ATTEMPTS : 1
    for (let attempt = 1; ; attempt += 1) {
      let response: MatrixFetchResponse
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json' },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error
        throw new MatrixUncertainError(`matrix ${method} ${path.split('?')[0]}: 网络异常 ${describe(error)}`)
      }
      const payload = await readJson(response)
      if (response.status === 429 && options.retryOn429 === true && attempt < maxAttempts) {
        const waitMs = rateLimitWaitMs(response, payload)
        if (waitMs !== undefined && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
          await sleep(waitMs)
          continue
        }
      }
      if (response.status >= 500) {
        throw new MatrixUncertainError(`matrix ${method} ${path.split('?')[0]}: HTTP ${response.status}`)
      }
      if (!response.ok) {
        const errcode = typeof payload?.errcode === 'string' ? payload.errcode : ''
        const errorText = typeof payload?.error === 'string' && payload.error !== '' ? payload.error : `HTTP ${response.status}`
        throw new MatrixApiError(`matrix ${method} ${path.split('?')[0]}: ${errcode === '' ? errorText : `${errcode} ${errorText}`}`, response.status, errcode)
      }
      if (payload === undefined) {
        throw new MatrixUncertainError(`matrix ${method} ${path.split('?')[0]}: 成功响应体不可解析`)
      }
      return payload as T
    }
  }

  private rememberSeen(eventId: string): void {
    if (this.seenEventIds.size >= SEEN_EVENT_LIMIT) {
      const oldest = this.seenEventIds.values().next()
      if (!oldest.done) this.seenEventIds.delete(oldest.value)
    }
    this.seenEventIds.add(eventId)
  }

  private rememberSelfEvent(eventId: string): void {
    if (this.selfEventIds.size >= SELF_EVENT_LIMIT) {
      const oldest = this.selfEventIds.values().next()
      if (!oldest.done) this.selfEventIds.delete(oldest.value)
    }
    this.selfEventIds.add(eventId)
  }
}

// —— 工具 ——————————————————————————————————————

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

async function readJson(response: MatrixFetchResponse): Promise<Record<string, any> | undefined> {
  try {
    const raw = await response.json()
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, any>) : undefined
  } catch {
    return undefined
  }
}

/** 429 等待时长：体里 retry_after_ms 优先，其次 Retry-After 头（秒）。 */
function rateLimitWaitMs(response: MatrixFetchResponse, payload: Record<string, any> | undefined): number | undefined {
  const fromBody = payload?.retry_after_ms
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody)
  const header = response.headers?.get('retry-after')
  if (typeof header === 'string' && header.trim() !== '') {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  }
  return undefined
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text) // 码点边界截断，不留孤立高位代理
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 剥离回复回退引用块（规范 Handling replies 口径）：以 `> ` 起始的若干行，
 * 单独一行 `> ` 或 `>` 为引用块与正文的分隔；无回退块时原文返回。
 */
export function stripReplyFallback(body: string): { text: string; quote?: string } {
  const lines = body.split('\n')
  if (lines.length === 0 || !lines[0].startsWith('> ')) return { text: body }
  const quoted: string[] = []
  let idx = 0
  let foundEnd = false
  for (; idx < lines.length; idx += 1) {
    const line = lines[idx]
    if (line === '> ' || line === '>') {
      idx += 1
      foundEnd = true
      break
    }
    if (!line.startsWith('> ')) {
      foundEnd = true
      break
    }
    quoted.push(line.slice(2))
  }
  // 无收尾分隔行（整段都是 `> ` 开头，如畸形/截断 body）→ 全量当正文，不吞内容。
  if (!foundEnd) return { text: body }
  const text = lines.slice(idx).join('\n')
  const quote = quoted.join('\n').trim()
  return quote === '' ? { text } : { text, quote: quote.slice(0, 200) }
}

function parseE2eeMode(raw: string | undefined, accountId: string): MatrixE2eeMode {
  if (raw === undefined || raw === '' || raw === 'optional') return 'optional'
  if (raw === 'required') return 'required'
  throw new Error(`matrix 账号 ${accountId}: config.encryption 只能是 optional|required（当前为 ${raw}）`)
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback // 0 会造成紧循环热轮询，拒收
}

/**
 * 工厂挂 registry（注册面由 registry.ts 追加，本文件不自带注册副作用）：
 * secrets.accessToken 缺位即抛；config.homeserverBaseUrl 缺位即抛；config.encryption 严格解析。
 */
export function createMatrixAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): MatrixAdapter {
  const accessToken = options.secrets.accessToken
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error(`matrix 账号 ${options.accountId}: accessToken 未入库（检查凭据配置）`)
  }
  const homeserverBaseUrl = options.config.homeserverBaseUrl
  if (typeof homeserverBaseUrl !== 'string' || homeserverBaseUrl === '') {
    throw new Error(`matrix 账号 ${options.accountId}: homeserverBaseUrl 未配置（形如 https://matrix.example.org）`)
  }
  const encryption = parseE2eeMode(options.config.encryption, options.accountId)
  const dmRoomList = (options.config.dmRoomList ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  const syncTimeoutMs = positiveIntOr(options.config.syncTimeoutMs, DEFAULT_SYNC_TIMEOUT_MS)
  return new MatrixAdapter({
    accessToken,
    homeserverBaseUrl,
    encryption,
    syncTimeoutMs,
    ...(dmRoomList.length > 0 ? { dmRoomList } : {}),
  })
}
