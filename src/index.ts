/**
 * dsh-im-union 宿主入口。
 *
 * 顶层 inject 只放必然存在的服务（webServer——web profile 的锚）；
 * 其余全部经 host-compat/services.ts 软读冻结成 capability。
 * 这是"装不上"与"装上静默失效"的分界：硬 inject 缺失服务 = Cordis 载入即抛，
 * 硬 inject 已删服务（settingsScope 类）= client 半永不 apply 且无红字。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CordisLike } from './types.js'
import { detectCapabilities } from './host-compat/services.js'
import { createSessionApi } from './host-compat/session-api.js'
import { createSessionEventTap } from './host-compat/session-event-tap.js'
import { initPluginFileLog, withFileLog } from './plugin-log.js'
import { attachInteraction } from './host-compat/interaction.js'
import { createVault } from './credentials/vault.js'
import { registerAdminApi, type AdminRequest, type AdminHandler } from './admin/api.js'
import { groupChannelSessions } from './admin/channels.js'
import { ChatRouter } from './engine/router.js'
import { ImUnionEngine } from './engine/gateway.js'
import { AccountManager, AccountValidationError, type AccountRecord } from './engine/account-manager.js'
import type { AccountSessionPrefs } from './engine/gateway.js'
import { DeliveryLog } from './engine/delivery-log.js'
import { FragmentBuffer } from './engine/fragments.js'
import { ProactiveDelivery, handleHttp as handleProactiveHttp } from './engine/proactive.js'
import { ConnectorService, handleHttp as handleConnectorHttp } from './engine/connector.js'
import { createUploadsCompat } from './host-compat/uploads-compat.js'
import { createDeliverablesCompat } from './host-compat/deliverables-compat.js'
import { CHANNEL_META, channelIds } from './channels/meta.js'
import { implementedChannels } from './channels/registry.js'
import { WeixinQrLogin } from './channels/weixin-qr.js'
import type { WecomAppAdapter, CallbackQuery } from './channels/wecom-app.js'
import { PLUGIN_NAME } from './host-compat/session-source.js'

export const name = PLUGIN_NAME

/**
 * inject 策略（desktop/Electron 线实证后的修订）：
 * - webServer：web profile 的锚，必然存在；
 * - agents/agentPresets/credentials/llm：会话/凭据/模型子系统的核心服务，全支持线
 *   （0.1.2+，dsh-im-connect 同 peer range 同款 inject 先例）必有。desktop 宿主上
 *   插件 apply 可能早于这些服务的 fiber 激活，软读会拿丢（ctx.get strict 语义）：
 *   agents/agentPresets 读丢=会话后端误判 none；credentials 读丢=凭据静默降级
 *   明文文件；llm 读丢=图片视觉判定永远未知。声明进 inject 走 cordis 等待语义，
 *   宿主备好服务才跑 apply；sessionController/workspaceController 等真可选面仍
 *   软读（optionalService 已带 reflect 非严格兜底），缺位照旧降级。
 */
export const inject = ['webServer', 'agents', 'agentPresets', 'credentials', 'llm']

export interface UnionPluginConfig {
  stateDir: string
  /** T2.7 AI Office Connector 远端 base URL；缺省/空=不启用（诚实降级）；非 https 拒启。 */
  connectorBaseUrl?: string
}

function accountRecordFromBody(body: unknown): { record: AccountRecord; secrets: Record<string, string> } {
  if (body === null || typeof body !== 'object') throw new AccountValidationError('请求体需为 JSON 对象')
  const b = body as Record<string, unknown>
  const raw = b.record ?? b
  const r = raw as Record<string, unknown>
  const record: AccountRecord = {
    accountId: String(r.accountId ?? ''),
    channel: String(r.channel ?? ''),
  }
  if (typeof r.alias === 'string' && r.alias !== '') record.alias = r.alias
  if (r.config !== null && typeof r.config === 'object') record.config = r.config as Record<string, string>
  if (Array.isArray(r.dmAllowlist)) record.dmAllowlist = r.dmAllowlist.map((v) => String(v))
  if (typeof r.groupEnabled === 'boolean') record.groupEnabled = r.groupEnabled
  if (typeof r.paused === 'boolean') record.paused = r.paused
  if (r.privateAccess === 'all' || r.privateAccess === 'approved') record.privateAccess = r.privateAccess
  // 命令执行开关（私聊/群聊各一档；只收布尔键，缺键=开）。
  if (r.commandExec !== null && typeof r.commandExec === 'object') {
    const rawExec = r.commandExec as Record<string, unknown>
    const exec: { dm: boolean; group: boolean } = { dm: true, group: true }
    if (typeof rawExec.dm === 'boolean') exec.dm = rawExec.dm
    if (typeof rawExec.group === 'boolean') exec.group = rawExec.group
    record.commandExec = exec
  }
  // 会话偏好：只收白名单字符串键（sanitize 在 manager 侧再兜一道）。
  if (r.session !== null && typeof r.session === 'object') {
    const rawSession = r.session as Record<string, unknown>
    const session: AccountSessionPrefs = {}
    for (const key of ['cwd', 'agentPreset', 'provider', 'model', 'reasoningEffort', 'permission'] as const) {
      const value = rawSession[key]
      if (typeof value === 'string' && value !== '') session[key] = value
    }
    record.session = session
  }
  const secrets: Record<string, string> = {}
  if (b.secrets !== null && typeof b.secrets === 'object') {
    for (const [k, v] of Object.entries(b.secrets as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') secrets[k] = v
    }
  }
  return { record, secrets }
}

export function apply(ctx: CordisLike, config?: Partial<UnionPluginConfig>): void {
  const log = withFileLog(ctx.logger(PLUGIN_NAME))
  const caps = detectCapabilities(ctx)
  const stateDir =
    config?.stateDir !== undefined && config.stateDir !== ''
      ? config.stateDir
      : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), PLUGIN_NAME)
  mkdirSync(stateDir, { recursive: true })
  // 文件日志（0.3.6）：desktop 宿主管线无文件落点，管理面 500 的
  // 「请查看本机日志」要有处可看。init 在所有可能打日志的组件之前。
  initPluginFileLog(stateDir)

  // vault：credentials 服务可达时主存宿主凭据库，并自动迁移历史文件库 secret
  // （0.3.2 修接线后 desktop 上主存切换，旧文件值会被孤儿化——真机实证 botToken 缺失）。
  const vault = createVault(caps.credentials, stateDir, (msg) => log.warn(msg))
  const router = new ChatRouter()
  const sessionApi = createSessionApi(ctx, caps)

  // M2 能力包（T2.4/T2.5/T2.8）：上传面/产物面构造期冻结（窄腰纪律）；
  // DeliveryLog 文件态异常只降级不拦装载。
  let deliveryLog: DeliveryLog | undefined
  try {
    deliveryLog = new DeliveryLog({ file: join(stateDir, 'deliveries.json'), logWarn: (msg) => log.warn(msg) })
  } catch (error) {
    log.warn(`投递日志未启用（${(error as Error).message}），/delivery /export 降级文案`)
  }
  const uploads = createUploadsCompat(ctx, caps)
  const deliverables = createDeliverablesCompat(ctx, caps)
  const fragments: FragmentBuffer = new FragmentBuffer({
    // 引擎回合重建在闭包延后取（apply 期内 engine 尚未声明，消息到来时必已初始化）。
    submit: (key: string, text: string): void => {
      engine.submitFragment(key, text)
    },
    logWarn: (msg) => log.warn(msg),
  })
  // 会话事件面（0.3.8）：session/event 总线优先——desktop 线实证 @Remote follow
  // 流帧直调收不到事件（回合零事件 → 全部看门狗超时）；缺位自动回退 follow 旧路。
  const eventTap = createSessionEventTap(ctx)
  log.info(eventTap !== undefined ? '会话事件面：session/event 总线' : '会话事件面：follow 回退（总线缺位）')
  const engine: ImUnionEngine = new ImUnionEngine({
    ctx,
    caps,
    sessionApi,
    router,
    eventTap,
    vaultKind: vault.kind,
    deliveryLog,
    uploads,
    deliverables,
    fragments,
    exportDir: join(stateDir, 'exports'),
    // 主动投递双向同步（T2.6）：syncBack 目标命中即自动入白名单——
    // 开关语义在此；botId 口径与 sendTo 缺省一致（accountId）。
    onInboundDm: (accountId, message) => {
      const hit = proactive.observeInbound({
        channel: message.address.channel,
        botId: accountId,
        targetId: message.userId,
        chatId: message.address.chatId,
        accountId,
      })
      if (!hit) return
      const rec = accounts.list().find((r) => r.accountId === accountId)
      if (rec === undefined || rec.dmAllowlist?.includes(message.userId) === true) return
      const next = [...(rec.dmAllowlist ?? []), message.userId]
      void accounts.setAllowlist(accountId, next).catch((error: Error) => log.warn(`syncBack 入白名单失败: ${error.message}`))
    },
  })

  // 渠道工厂表在 registry.ts 模块加载时静态登记（懒加载不变）。

  // T1.8 账号管理：文件态存储 + 生命周期（启动全连 + 管理面 CRUD）。
  const accounts = new AccountManager({
    stateFile: join(stateDir, 'accounts.json'),
    vault,
    engine,
    logWarn: (msg) => log.warn(msg),
    logInfo: (msg) => log.info(msg),
    stateDir,
  })
  void accounts.startAll()

  // T2.6 主动投递：目标库文件态 + 账号解析（歧义不猜，报 no-account）。
  const proactive = new ProactiveDelivery({
    file: join(stateDir, 'proactive-targets.json'),
    resolveAccount: (channel, botId) => {
      const rows = accounts.list()
      if (botId !== undefined) {
        return rows.find((r) => r.channel === channel && (r.accountId === botId || r.alias === botId))?.accountId
      }
      const live = rows.filter((r) => r.channel === channel && r.paused !== true)
      return live.length === 1 ? live[0]?.accountId : undefined
    },
    getAdapter: (accountId) => accounts.liveAdapter(accountId),
    logWarn: (msg) => log.warn(msg),
  })

  // T2.7 AI Office Connector：未配 baseUrl=不启用；构造即抛（非 https）只记 warn 不拦装载。
  let connector: ConnectorService | undefined
  if (config?.connectorBaseUrl !== undefined && config.connectorBaseUrl !== '') {
    try {
      connector = new ConnectorService({
        vault,
        stateFile: join(stateDir, 'connector-jobs.json'),
        baseUrl: config.connectorBaseUrl,
        logWarn: (msg) => log.warn(msg),
      })
      connector.start()
    } catch (error) {
      log.warn(`Connector 未启用：${(error as Error).message}`)
    }
  }

  const accountRoutes = {
    /** 微信扫码绑定（T1.2 bind:'qr'）：取码 + PNG data URL（零凭据零 token）。 */
    '/weixin/qr/start': async ({ respond }: AdminRequest) => {
      const qr = new WeixinQrLogin((globalThis as { fetch: any }).fetch, (m) => log.warn(m))
      try {
        const { qrcode, qrDataUrl } = await qr.start()
        respond(200, { ok: true, qrcode, qrDataUrl })
      } catch (error) {
        respond(502, { ok: false, error: String((error as Error)?.message ?? error) })
      }
    },
    /** 轮询扫码状态；confirmed 时 bot_token 单向写 vault（回包零值，D4）。 */
    '/weixin/qr/status': async ({ body, respond }: AdminRequest) => {
      const b = (body ?? {}) as { qrcode?: unknown; verifyCode?: unknown; accountId?: unknown }
      const qrcode = String(b.qrcode ?? '')
      const accountId = String(b.accountId ?? '')
      if (qrcode === '' || accountId === '') {
        respond(400, { ok: false, error: 'qrcode 与 accountId 必填' })
        return
      }
      const qr = new WeixinQrLogin((globalThis as { fetch: any }).fetch, (m) => log.warn(m))
      try {
        const result = await qr.pollStatus(qrcode, typeof b.verifyCode === 'string' ? b.verifyCode : undefined)
        if (result.status !== 'confirmed') {
          respond(200, { ok: true, status: result.status })
          return
        }
        // 已有记录保留其配置再写 token（upsert 整值替换语义）；无记录建最小记录。
        const existing = accounts.list().find((r) => r.accountId === accountId && r.channel === 'weixin')
        const record: AccountRecord = existing ?? { accountId, channel: 'weixin' }
        await accounts.upsert(record, { botToken: result.account.botToken })
        respond(200, { ok: true, status: 'confirmed', bound: true })
      } catch (error) {
        respond(502, { ok: false, error: String((error as Error)?.message ?? error) })
      }
    },
    /** 脱敏列表（零 secret 值，D4）。 */
    '/accounts': async ({ respond }: AdminRequest) => {
      respond(200, { ok: true, accounts: await accounts.listPublic() })
    },
    /** 会话偏好目录（设置页下拉数据源）：工作区 cwd 聚合 + 模型目录 + 预设清单 + 权限预设。 */
    '/session-catalog': async ({ respond }: AdminRequest) => {
      const empty = {
        ok: true,
        backend: sessionApi.backend,
        workspaces: [] as string[],
        providers: [] as unknown[],
        defaults: null,
        presets: [] as unknown[],
        permissions: [] as unknown[],
        defaultPermission: null,
      }
      if (sessionApi.backend !== 'native') {
        respond(200, empty)
        return
      }
      try {
        const [catalog, presets, sessions, permissions] = await Promise.all([
          sessionApi.modelCatalog(),
          sessionApi.presetsList(),
          sessionApi.listSessions().catch(() => []),
          sessionApi.permissionCatalog().catch(() => undefined),
        ])
        // 工作区候选 = 现有会话 cwd 去重（workspaceController 无 list 面，feed 流
        // 不适合一次性拉取；cwd 直传 create 已由宿主 commands.ts:99-102 落位）。
        const workspaces = [...new Set(sessions.map((s) => s.cwd).filter((v): v is string => typeof v === 'string' && v !== ''))]
        respond(200, {
          ok: true,
          backend: sessionApi.backend,
          workspaces,
          providers: catalog?.groups ?? [],
          defaults: catalog?.default ?? null,
          presets,
          permissions: permissions?.options ?? [],
          defaultPermission: permissions?.default ?? null,
        })
      } catch (error) {
        log.warn(`session-catalog 组装失败（回空目录）: ${error instanceof Error ? error.message : String(error)}`)
        respond(200, empty)
      }
    },
    /** 渠道视角数据面（0.4.0）：im:union: 会话按渠道分组（rail 数据源，零 secret，D4）。 */
    '/channels': async ({ respond }: AdminRequest) => {
      const empty = { ok: true, groups: [] as unknown[] }
      if (sessionApi.backend !== 'native') {
        respond(200, empty)
        return
      }
      try {
        const sessions = await sessionApi.listSessions()
        const groups = groupChannelSessions(sessions, {
          bound: new Set(router.boundSessionIds()),
          historical: (id) => router.isHistorical(id),
          lastOut: deliveryLog?.lastOutBySession() ?? new Map<string, number>(),
        })
        respond(200, { ok: true, groups })
      } catch (error) {
        log.warn(`channels 组装失败（回空组）: ${error instanceof Error ? error.message : String(error)}`)
        respond(200, empty)
      }
    },
    '/accounts/save': async ({ body, respond }: AdminRequest) => {
      try {
        const { record, secrets } = accountRecordFromBody(body)
        const skipConnect = (body as { skipConnect?: unknown } | null)?.skipConnect === true
        await accounts.upsert(record, secrets, { skipConnect })
        respond(200, { ok: true, connected: !skipConnect && record.paused !== true })
      } catch (error) {
        if (error instanceof AccountValidationError) {
          respond(400, { ok: false, error: error.message })
          return
        }
        throw error
      }
    },
    '/accounts/remove': async ({ body, respond }: AdminRequest) => {
      const accountId = String((body as { accountId?: unknown })?.accountId ?? '')
      const removed = await accounts.remove(accountId)
      respond(removed ? 200 : 404, { ok: removed, error: removed ? undefined : '账号不存在' })
    },
    '/accounts/pause': async ({ body, respond }: AdminRequest) => {
      const b = (body ?? {}) as { accountId?: unknown; paused?: unknown }
      const ok = await accounts.setPaused(String(b.accountId ?? ''), b.paused !== false)
      respond(ok ? 200 : 404, { ok, error: ok ? undefined : '账号不存在' })
    },
    '/accounts/allowlist': async ({ body, respond }: AdminRequest) => {
      const b = (body ?? {}) as { accountId?: unknown; userIds?: unknown }
      if (!Array.isArray(b.userIds)) {
        respond(400, { ok: false, error: 'userIds 需为数组' })
        return
      }
      try {
        const ok = await accounts.setAllowlist(String(b.accountId ?? ''), b.userIds.map((v) => String(v)))
        respond(ok ? 200 : 404, { ok, error: ok ? undefined : '账号不存在' })
      } catch (error) {
        if (error instanceof AccountValidationError) {
          respond(400, { ok: false, error: error.message })
          return
        }
        throw error
      }
    },
    /** 检查连接：诊断面逐账号，回包已过脱敏纪律（E5）。 */
    '/accounts/check': async ({ body, respond }: AdminRequest) => {
      try {
        const accountId = String((body as { accountId?: unknown })?.accountId ?? '')
        respond(200, { ok: true, checks: await accounts.check(accountId) })
      } catch (error) {
        if (error instanceof AccountValidationError) {
          respond(404, { ok: false, error: error.message })
          return
        }
        throw error
      }
    },
  }

  // 管理面：只读探针 + 账号 CRUD + 微信扫码 + 企微自建应用回调（T3.4）。
  const wecomAppCallback: AdminHandler = async ({ method, query, rawBody, respond, respondText }) => {
    // 认证即验签（admin 框已在 rawRoutes 分流；此处 fail-closed：无命中一律 403）。
    const adapters = accounts.liveAdapters('wecom-app') as unknown as WecomAppAdapter[]
    if (adapters.length === 0) {
      respond(404, { ok: false, error: '未配置企微自建应用账号' })
      return
    }
    const q = (query ?? {}) as CallbackQuery
    if (method === 'GET') {
      for (const adapter of adapters) {
        const echo = adapter.verifyUrl(q)
        if (echo !== null) {
          if (respondText !== undefined) respondText(200, echo)
          else respond(200, { ok: true, echo })
          return
        }
      }
      respond(403, { ok: false, error: '回调验签未通过' })
      return
    }
    for (const adapter of adapters) {
      const result = adapter.handleXmlCallback(q, rawBody ?? '')
      if (result.ok) {
        // 企微要求 5s 内响应；消息已同步入队，回 success 即签收。
        if (respondText !== undefined) respondText(200, 'success')
        else respond(200, { ok: true })
        return
      }
    }
    respond(403, { ok: false, error: '回调验签/解密未通过' })
  }
  // M2 服务侧路由：主动投递四端点 + Connector Job 面（admin 精确匹配，
  // cancel 以 body.jobId 重建路径；鉴权复用既有 Cookie/Origin 闸，模块内零第二套认证）。
  const wrapProactive = (routePath: string): AdminHandler => {
    return async ({ method, body, respond }) => {
      const result = await handleProactiveHttp({ service: proactive, logWarn: (msg) => log.warn(msg) }, { method, path: routePath, body })
      respond(result.status, result.json)
    }
  }
  const connectorHandler = (routePath: string): AdminHandler => {
    return async ({ method, body, respond }) => {
      if (connector === undefined) {
        respond(404, { ok: false, error: 'Connector 未配置（connectorBaseUrl 为空）' })
        return
      }
      const jobId = String((body as { jobId?: unknown } | null)?.jobId ?? '')
      const path = routePath === '/connector/jobs/cancel' ? `/connector/jobs/${encodeURIComponent(jobId)}/cancel` : routePath
      const result = await handleConnectorHttp({ service: connector, logWarn: (msg) => log.warn(msg) }, { method, path, body })
      respond(result.status, result.json)
    }
  }

  const admin = registerAdminApi(ctx, {
    '/ping': ({ respond }) => {
      respond(200, { ok: true, plugin: PLUGIN_NAME })
    },
    '/state': ({ respond }) => {
      // 回包零凭据零原始用户标识（红线 D4）：只出能力快照与渠道实现度。
      respond(200, {
        ok: true,
        capabilities: {
          settingsGeneration: caps.settingsGeneration,
          sessionBackend: sessionApi.backend,
          vaultKind: vault.kind,
          hasSharedFetch: caps.hasSharedFetch,
          hasRequestRejection: caps.hasRequestRejection,
          uploadsMode: uploads.mode,
          deliverablesMode: deliverables.mode,
          connectorEnabled: connector !== undefined,
        },
        channels: channelIds().map((id) => ({
          id,
          label: CHANNEL_META[id].label,
          bind: CHANNEL_META[id].bind,
          implemented: implementedChannels().includes(id),
          // 账号 ID = 代理键（CMDB 同构：主键系统生成，业务标识归属性/别名）——
          // 全渠道统一自动生成，设置页不再要求用户填内部键。
          autoAccountId: true,
          // 纯出站通知类：client 隐藏白名单编辑块，manager 拒写策略字段。
          notifyOnly: CHANNEL_META[id].notifyOnly === true,
          // 本机条件渠道（iMessage=macOS 等）：设置页据此打标签灰显提示。
          ...(CHANNEL_META[id].hostRequirement !== undefined
            ? { hostRequirement: CHANNEL_META[id].hostRequirement }
            : {}),
          // 表单驱动元数据（零敏感：字段名/标签/形态，不含值）。
          fields: CHANNEL_META[id].fields.map((f) => ({
            key: f.key,
            label: f.label,
            secret: f.secret,
            required: f.required,
            ...(f.helpUrl !== undefined ? { helpUrl: f.helpUrl } : {}),
          })),
        })),
      })
    },
    ...accountRoutes,
    '/proactive/send': wrapProactive('/proactive/send'),
    '/proactive/targets': wrapProactive('/proactive/targets'),
    '/proactive/targets/remove': wrapProactive('/proactive/targets/remove'),
    '/proactive/syncback': wrapProactive('/proactive/syncback'),
    '/connector/jobs': connectorHandler('/connector/jobs'),
    '/connector/jobs/cancel': connectorHandler('/connector/jobs/cancel'),
    '/wecom-app/callback': wecomAppCallback,
  }, {
    // 第三方回调白名单：跳登录态/JSON 闸（厂商无 Cookie，验签即认证）。
    rawRoutes: [{ path: '/wecom-app/callback', plainText: true }],
  })

  // 审批/提问接管（T1.9）：waterfall 返回值即裁决——查不到发起聊天的请求
  // 由 broker 内 next() 委派回网页 UI；接管时原聊天闭环、超时/失败 fail-closed（D5）。
  const detachInteraction = attachInteraction(ctx, {
    onApproval: (request, next) => engine.handleApproval(request, next),
    onQuestion: (request, next) => engine.handleQuestion(request, next),
  })

  const dispose = ctx.effect?.(() => {
    return () => {
      void accounts.stopAll()
      fragments.dispose()
      connector?.dispose()
      admin.dispose()
      detachInteraction()
    }
  }, `${PLUGIN_NAME}: lifecycle`)
  if (dispose === undefined) {
    log.warn('宿主 ctx.effect 不可用，卸载钩子未挂（HMR 场景可能残留监听）')
  }

  // 供宿主 GUI/其他插件嵌入面板的可选服务（dsh-im 的 dshImClient 范式，M1 完善）。
  try {
    ctx.provide?.(`${PLUGIN_NAME}.state`, {
      contractVersion: 1,
      capabilities: { settingsGeneration: caps.settingsGeneration, sessionBackend: sessionApi.backend },
    })
  } catch {
    // provide 面在老线形态不同，失败不影响主流程。
  }

  log.info(
    `apply 完成：设置面 ${caps.settingsGeneration}，会话后端 ${sessionApi.backend}，凭据 ${vault.kind}。`,
  )
}
