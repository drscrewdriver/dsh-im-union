/**
 * 主动投递（M2 T2.6）——纯服务面，宿主接线点全部走注入。
 *
 * 纪律与红线：
 * - **不 import gateway / account-manager**（防环）：账号→适配器解析由主会话
 *   接线时注入 `resolveAccount(channel, botId?)` 与 `getAdapter(accountId)` 回调；
 * - 目标库文件态 `<stateDir>/proactive-targets.json`：原子写（tmp+rename），
 *   损坏 → warn + 改名 `.corrupt-<ts>` 后从空表继续（对齐 delivery-log 姿态）；
 * - **零 secret**：目标库只存 channel/botId/targetId/chatId/alias/syncBack/updatedAt，
 *   绝不写 token、原始平台响应、内部异常堆栈（细节只进本机日志，D4）；
 * - 红线 D7：`Receipt.uncertain` 的投递**绝不自动重发**，只回状态；
 * - 鉴权口径：sendTo/handleHttp 的发起鉴权由管理面既有 Cookie/Origin 闸
 *   （admin/api.ts requestRejection）负责，**本模块内不做第二套认证**；
 * - dmAllowlist 联动：syncBack 目标被 observeInbound 命中时，本模块只记录事实
 *   并暴露 `pendingAllowlistSuggestions()` 查询面，是否写入账号白名单由主会话决定。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ChannelAdapter, Receipt } from '../channels/types.js'
import type { ChatAddress } from './router.js'
import type { DeliveryStatus } from './delivery-log.js'

/** 目标库记录（零 secret）。botId = accountId 或平台 bot 标识；targetId = 平台用户 id。 */
export interface ProactiveTarget {
  channel: string
  botId: string
  targetId: string
  /** 平台 targetId → 会话 chatId 映射；缺省时 chatId 即 targetId。 */
  chatId: string
  alias?: string
  /** 私聊双向同步开关：true 时宿主侧来源的消息也记入该目标。 */
  syncBack: boolean
  updatedAt: number
}

export interface ProactiveDeliveryDeps {
  /** 目标库文件路径（主会话传 join(stateDir, 'proactive-targets.json')）。 */
  file: string
  /** 渠道 + 可选 bot 标识 → accountId；歧义/无匹配回 undefined（主会话实现）。 */
  resolveAccount: (channel: string, botId?: string) => string | undefined
  /** accountId → 在位适配器；不在位回 undefined（主会话实现）。 */
  getAdapter: (accountId: string) => ChannelAdapter | undefined
  now?: () => number
  logWarn?: (msg: string) => void
}

export interface ProactiveSendInput {
  channel: string
  botId?: string
  targetId: string
  text: string
}

export interface ProactiveSendOptions {
  /** 投递成功后是否落目标库（默认 true）。 */
  remember?: boolean
  /** 目标库 chatId 显式覆盖（缺省用既有映射或 targetId）。 */
  chatId?: string
  /** 目标库 alias（remember 时写入）。 */
  alias?: string
  /** 目标库 syncBack（remember 时写入；缺省沿用既有记录或 false）。 */
  syncBack?: boolean
  signal?: AbortSignal
}

export interface ProactiveSendResult {
  channel: string
  botId: string
  targetId: string
  chatId: string
  accountId?: string
  /** 三态：delivered / failed / uncertain（uncertain 绝不重发，D7）。 */
  status: DeliveryStatus
  /** 粗分类（'invalid'/'no-account'/'send-error'），非异常原文（D4）。 */
  error?: string
}

export interface ProactiveTargetFilter {
  channel?: string
}

export interface ObserveInboundInput {
  channel: string
  botId?: string
  targetId: string
  chatId?: string
  accountId?: string
}

/** syncBack 目标被入站命中后登记的白名单候选事实（主会话决定是否入表）。 */
export interface AllowlistSuggestion {
  channel: string
  botId: string
  targetId: string
  accountId?: string
  at: number
}

function targetKey(channel: string, botId: string, targetId: string): string {
  return `${channel}\u0000${botId}\u0000${targetId}`
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// —— 目标库文件态（对齐 delivery-log 的原子写/损坏姿态）——————————

function loadTargets(
  file: string,
  now: () => number,
  logWarn?: (msg: string) => void,
): ProactiveTarget[] {
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    const corrupt = `${file}.corrupt-${stamp}`
    try {
      renameSync(file, corrupt)
    } catch {
      // 改名失败也不阻塞运行。
    }
    logWarn?.(`proactive-targets.json 损坏，已转存 ${corrupt} 并从空表继续: ${(error as Error).message}`)
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : []
  return rows
    .map((row): ProactiveTarget | undefined => {
      if (row === null || typeof row !== 'object') return undefined
      const r = row as Record<string, unknown>
      const channel = str(r.channel)
      const targetId = str(r.targetId)
      if (channel === '' || targetId === '') return undefined
      const botId = str(r.botId)
      const target: ProactiveTarget = {
        channel,
        botId,
        targetId,
        chatId: str(r.chatId) !== '' ? str(r.chatId) : targetId,
        syncBack: r.syncBack === true,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now(),
      }
      if (typeof r.alias === 'string' && r.alias !== '') target.alias = r.alias
      return target
    })
    .filter((row): row is ProactiveTarget => row !== undefined)
}

export class ProactiveDelivery {
  private targets: ProactiveTarget[] = []
  /** 运行期内存态：syncBack 命中产生的白名单候选（零 secret，跨重启不持久）。 */
  private suggestions = new Map<string, AllowlistSuggestion>()
  private readonly now: () => number

  constructor(private readonly deps: ProactiveDeliveryDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.targets = loadTargets(deps.file, this.now, deps.logWarn)
  }

  // —— 文件态写入 ——————————————————————————————

  private persist(): void {
    const tmp = `${this.deps.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.targets, null, 2), 'utf8')
    renameSync(tmp, this.deps.file)
  }

  private find(channel: string, botId: string | undefined, targetId: string): ProactiveTarget | undefined {
    return this.targets.find(
      (t) => t.channel === channel && t.targetId === targetId && (botId === undefined || t.botId === botId),
    )
  }

  // —— 目标库 CRUD ——————————————————————————————

  listTargets(filter?: ProactiveTargetFilter): ProactiveTarget[] {
    const rows = filter?.channel !== undefined ? this.targets.filter((t) => t.channel === filter.channel) : this.targets
    return rows.map((t) => ({ ...t }))
  }

  /** 落库/整体更新一条目标（键=channel+botId+targetId）；syncBack/alias/chatId 缺省沿用既有记录。 */
  upsertTarget(input: {
    channel: string
    botId?: string
    targetId: string
    chatId?: string
    alias?: string
    syncBack?: boolean
  }): ProactiveTarget {
    const channel = str(input.channel)
    const targetId = str(input.targetId)
    const botId = input.botId !== undefined ? str(input.botId) : ''
    const existing = this.find(channel, botId, targetId)
    const target: ProactiveTarget = {
      channel,
      botId,
      targetId,
      chatId: str(input.chatId) !== '' ? str(input.chatId) : (existing?.chatId ?? targetId),
      syncBack: input.syncBack ?? existing?.syncBack ?? false,
      updatedAt: this.now(),
    }
    const alias = input.alias !== undefined ? str(input.alias) : existing?.alias
    if (alias !== undefined && alias !== '') target.alias = alias
    if (existing !== undefined) {
      this.targets[this.targets.indexOf(existing)] = target
    } else {
      this.targets.push(target)
    }
    this.persist()
    return { ...target }
  }

  /** 移除目标；botId 省略时按 channel+targetId 匹配任意 bot。 */
  removeTarget(input: { channel: string; botId?: string; targetId: string }): boolean {
    const channel = str(input.channel)
    const targetId = str(input.targetId)
    if (channel === '' || targetId === '') return false
    const botId = input.botId !== undefined ? str(input.botId) : undefined
    const hit = this.find(channel, botId, targetId)
    if (hit === undefined) return false
    this.targets.splice(this.targets.indexOf(hit), 1)
    this.suggestions.delete(targetKey(hit.channel, hit.botId, hit.targetId))
    this.persist()
    return true
  }

  /** 私聊双向同步开关；目标不存在回 false（HTTP 面据此转 404）。 */
  setSyncBack(input: { channel: string; botId?: string; targetId: string; enabled: boolean }): boolean {
    const channel = str(input.channel)
    const targetId = str(input.targetId)
    if (channel === '' || targetId === '') return false
    const botId = input.botId !== undefined ? str(input.botId) : undefined
    const hit = this.find(channel, botId, targetId)
    if (hit === undefined) return false
    hit.syncBack = input.enabled === true
    hit.updatedAt = this.now()
    this.persist()
    return true
  }

  // —— 投递 ——————————————————————————————————

  /**
   * 主动投递一条私聊消息：解析账号适配器 → 构造 ChatAddress{kind:'dm', chatId}
   * → adapter.reply。uncertain 不重发只回状态（D7）。
   * 发起鉴权由管理面既有 Cookie/Origin 闸负责，本方法内不做第二套认证。
   */
  async sendTo(input: ProactiveSendInput, opts: ProactiveSendOptions = {}): Promise<ProactiveSendResult> {
    const channel = str(input.channel)
    const targetId = str(input.targetId)
    const text = typeof input.text === 'string' ? input.text : ''
    const accountId = channel !== '' ? this.deps.resolveAccount(channel, input.botId) : undefined
    const botId = input.botId !== undefined ? str(input.botId) : (accountId ?? '')
    const existing = this.find(channel, botId, targetId)
    const chatId = str(opts.chatId) !== '' ? str(opts.chatId) : (existing?.chatId ?? targetId)
    const result: ProactiveSendResult = { channel, botId, targetId, chatId, accountId, status: 'failed' }

    if (channel === '' || targetId === '' || text.trim() === '') {
      result.error = 'invalid'
      return result
    }
    const adapter = accountId !== undefined ? this.deps.getAdapter(accountId) : undefined
    if (adapter === undefined) {
      result.error = 'no-account'
      return result
    }

    const address: ChatAddress = { channel, kind: 'dm', chatId }
    let receipt: Receipt
    try {
      receipt = await adapter.reply(address, text, opts.signal)
    } catch (error) {
      // 内部异常原文只进本机日志，回包零细节（D4）。
      this.deps.logWarn?.(`主动投递异常 (${channel}/${targetId}): ${(error as Error).message}`)
      result.status = 'failed'
      result.error = 'send-error'
      return result
    }

    if (receipt?.uncertain === true) {
      // D7：结果不明，绝不自动重发；也不落新目标（不确定是否真送达）。
      this.deps.logWarn?.(`主动投递结果不明 (${channel}/${targetId})，不自动重发（D7）`)
      result.status = 'uncertain'
      return result
    }

    result.status = 'delivered'
    if (opts.remember !== false) {
      this.upsertTarget({ channel, botId, targetId, chatId, alias: opts.alias, syncBack: opts.syncBack })
    }
    return result
  }

  /** 全量/按渠道逐个投递，回汇总清单（每目标三态）。 */
  async broadcast(text: string, filter?: ProactiveTargetFilter): Promise<ProactiveSendResult[]> {
    const targets = this.listTargets(filter)
    const out: ProactiveSendResult[] = []
    for (const target of targets) {
      out.push(
        await this.sendTo(
          { channel: target.channel, botId: target.botId, targetId: target.targetId, text },
          { chatId: target.chatId },
        ),
      )
    }
    return out
  }

  // —— 双向同步（私聊 syncBack）————————————————

  /**
   * 主会话喂入站事件：命中 syncBack=true 目标时更新其映射并登记白名单候选事实。
   * 未命中/syncBack 关闭 → 不动作回 false。本模块不写账号策略。
   */
  observeInbound(input: ObserveInboundInput): boolean {
    const channel = str(input.channel)
    const targetId = str(input.targetId)
    if (channel === '' || targetId === '') return false
    const botId = input.botId !== undefined ? str(input.botId) : (input.accountId !== undefined ? str(input.accountId) : '')
    const hit = this.find(channel, botId !== '' ? botId : undefined, targetId)
    if (hit === undefined || hit.syncBack !== true) return false
    if (str(input.chatId) !== '') hit.chatId = str(input.chatId)
    hit.updatedAt = this.now()
    this.persist()
    const key = targetKey(hit.channel, hit.botId, hit.targetId)
    // 重复命中只刷新 at（首次发现时间无需保留——候选语义是「最近活跃」）。
    this.suggestions.set(key, {
      channel: hit.channel,
      botId: hit.botId,
      targetId: hit.targetId,
      accountId: input.accountId,
      at: this.now(),
    })
    return true
  }

  /** 白名单候选查询面（主会话据此决定是否调 account-manager.setAllowlist）。 */
  pendingAllowlistSuggestions(): AllowlistSuggestion[] {
    return [...this.suggestions.values()].map((s) => ({ ...s }))
  }

  /** 主会话处置完候选后清除（可选面）。 */
  resolveAllowlistSuggestion(input: { channel: string; botId?: string; targetId: string }): boolean {
    const channel = str(input.channel)
    const targetId = str(input.targetId)
    const botId = input.botId !== undefined ? str(input.botId) : ''
    return this.suggestions.delete(targetKey(channel, botId, targetId))
  }
}

// —— HTTP/RPC 纯 handler 面（不碰框架，主会话接进 admin 路由/宿主 RPC）——

export interface ProactiveHttpRequest {
  method: string
  path: string
  body?: unknown
}

export interface ProactiveHttpResponse {
  status: number
  json: unknown
}

export interface ProactiveHttpDeps {
  service: ProactiveDelivery
  logWarn?: (msg: string) => void
}

const KNOWN_PATHS = ['/proactive/send', '/proactive/targets', '/proactive/targets/remove', '/proactive/syncback']

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  return body as Record<string, unknown>
}

function optionalBotId(b: Record<string, unknown>): string | undefined {
  return typeof b.botId === 'string' && b.botId.trim() !== '' ? b.botId.trim() : undefined
}

async function handleSend(service: ProactiveDelivery, body: unknown): Promise<ProactiveHttpResponse> {
  const b = bodyObject(body)
  if (b === undefined) return { status: 400, json: { ok: false, error: '请求体需为 JSON 对象' } }
  const channel = str(b.channel)
  const targetId = str(b.targetId)
  const text = typeof b.text === 'string' ? b.text : ''
  if (channel === '' || targetId === '') {
    return { status: 400, json: { ok: false, error: 'channel 与 targetId 必填' } }
  }
  if (text.trim() === '') return { status: 400, json: { ok: false, error: '投递内容不能为空' } }
  const result = await service.sendTo({ channel, botId: optionalBotId(b), targetId, text })
  return { status: 200, json: { ok: true, ...result } }
}

function handleRemove(service: ProactiveDelivery, body: unknown): ProactiveHttpResponse {
  const b = bodyObject(body)
  if (b === undefined) return { status: 400, json: { ok: false, error: '请求体需为 JSON 对象' } }
  const channel = str(b.channel)
  const targetId = str(b.targetId)
  if (channel === '' || targetId === '') {
    return { status: 400, json: { ok: false, error: 'channel 与 targetId 必填' } }
  }
  const removed = service.removeTarget({ channel, botId: optionalBotId(b), targetId })
  return removed
    ? { status: 200, json: { ok: true, removed: true } }
    : { status: 404, json: { ok: false, error: '未找到该投递目标' } }
}

function handleSyncBack(service: ProactiveDelivery, body: unknown): ProactiveHttpResponse {
  const b = bodyObject(body)
  if (b === undefined) return { status: 400, json: { ok: false, error: '请求体需为 JSON 对象' } }
  const channel = str(b.channel)
  const targetId = str(b.targetId)
  if (channel === '' || targetId === '') {
    return { status: 400, json: { ok: false, error: 'channel 与 targetId 必填' } }
  }
  if (typeof b.enabled !== 'boolean') {
    return { status: 400, json: { ok: false, error: 'enabled 需为布尔值' } }
  }
  const ok = service.setSyncBack({ channel, botId: optionalBotId(b), targetId, enabled: b.enabled })
  return ok
    ? { status: 200, json: { ok: true, syncBack: b.enabled } }
    : { status: 404, json: { ok: false, error: '未找到该投递目标' } }
}

/**
 * 主动投递管理面纯 handler：入参 {method, path, body}，出参 {status, json}。
 * 校验失败 400 带用户可读文案，未知目标 404，未知路径 404，方法不符 405，
 * 内部异常一律吞成 500 通用文案（细节进本机日志，零回显，D4）。
 * 鉴权由调用方（admin/api.ts 的 Cookie/Origin 闸）负责，此处不做第二套认证。
 */
export async function handleHttp(deps: ProactiveHttpDeps, req: ProactiveHttpRequest): Promise<ProactiveHttpResponse> {
  const method = (req.method ?? 'GET').toUpperCase()
  const path = req.path ?? ''
  try {
    if (path === '/proactive/send') return method === 'POST' ? await handleSend(deps.service, req.body) : methodNotAllowed()
    if (path === '/proactive/targets') {
      return method === 'GET'
        ? { status: 200, json: { ok: true, targets: deps.service.listTargets() } }
        : methodNotAllowed()
    }
    if (path === '/proactive/targets/remove') return method === 'POST' ? handleRemove(deps.service, req.body) : methodNotAllowed()
    if (path === '/proactive/syncback') return method === 'POST' ? handleSyncBack(deps.service, req.body) : methodNotAllowed()
    return { status: 404, json: { ok: false, error: '未找到该接口' } }
  } catch (error) {
    deps.logWarn?.(`proactive 管理面处理异常: ${(error as Error).message}`)
    return { status: 500, json: { ok: false, error: '操作失败，请查看本机日志' } }
  }
}

function methodNotAllowed(): ProactiveHttpResponse {
  return { status: 405, json: { ok: false, error: '方法不允许' } }
}

// KNOWN_PATHS 保留给主会话接线侧核对（避免死代码告警的同时提供清单导出）。
export { KNOWN_PATHS as PROACTIVE_PATHS }
