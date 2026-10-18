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
import { attachInteraction } from './host-compat/interaction.js'
import { createVault } from './credentials/vault.js'
import { registerAdminApi, type AdminRequest, type AdminHandler } from './admin/api.js'
import { ChatRouter } from './engine/router.js'
import { ImUnionEngine } from './engine/gateway.js'
import { AccountManager, AccountValidationError, type AccountRecord } from './engine/account-manager.js'
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

/** 只 inject 必然存在的服务；可选服务在 services.ts 软读。 */
export const inject = ['webServer']

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
  const secrets: Record<string, string> = {}
  if (b.secrets !== null && typeof b.secrets === 'object') {
    for (const [k, v] of Object.entries(b.secrets as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') secrets[k] = v
    }
  }
  return { record, secrets }
}

export function apply(ctx: CordisLike, config?: Partial<UnionPluginConfig>): void {
  const log = ctx.logger(PLUGIN_NAME)
  const caps = detectCapabilities(ctx)
  const stateDir =
    config?.stateDir !== undefined && config.stateDir !== ''
      ? config.stateDir
      : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), PLUGIN_NAME)
  mkdirSync(stateDir, { recursive: true })

  const vault = createVault(caps.credentials, stateDir)
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
  const engine: ImUnionEngine = new ImUnionEngine({
    ctx,
    caps,
    sessionApi,
    router,
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
      const ok = await accounts.setAllowlist(String(b.accountId ?? ''), b.userIds.map((v) => String(v)))
      respond(ok ? 200 : 404, { ok, error: ok ? undefined : '账号不存在' })
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
          // 纯出站通知类：设置页隐藏账号 ID（自动生成）。
          notifyOnly: CHANNEL_META[id].notifyOnly === true,
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
