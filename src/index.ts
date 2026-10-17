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
import { registerAdminApi, type AdminRequest } from './admin/api.js'
import { ChatRouter } from './engine/router.js'
import { ImUnionEngine } from './engine/gateway.js'
import { AccountManager, AccountValidationError, type AccountRecord } from './engine/account-manager.js'
import { CHANNEL_META, channelIds } from './channels/meta.js'
import { implementedChannels } from './channels/registry.js'
import { PLUGIN_NAME } from './host-compat/session-source.js'

export const name = PLUGIN_NAME

/** 只 inject 必然存在的服务；可选服务在 services.ts 软读。 */
export const inject = ['webServer']

export interface UnionPluginConfig {
  stateDir: string
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
  const engine = new ImUnionEngine({ ctx, caps, sessionApi, router, vaultKind: vault.kind })

  // 渠道工厂表在 registry.ts 模块加载时静态登记（懒加载不变）。

  // T1.8 账号管理：文件态存储 + 生命周期（启动全连 + 管理面 CRUD）。
  const accounts = new AccountManager({
    stateFile: join(stateDir, 'accounts.json'),
    vault,
    engine,
    logWarn: (msg) => log.warn(msg),
  })
  void accounts.startAll()

  const accountRoutes = {
    /** 脱敏列表（零 secret 值，D4）。 */
    '/accounts': async ({ respond }: AdminRequest) => {
      respond(200, { ok: true, accounts: await accounts.listPublic() })
    },
    '/accounts/save': async ({ body, respond }: AdminRequest) => {
      try {
        const { record, secrets } = accountRecordFromBody(body)
        await accounts.upsert(record, secrets)
        respond(200, { ok: true })
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

  // 管理面：只读探针 + 账号 CRUD（T1.8 服务侧；扫码配对归各渠道后续迭代）。
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
        },
        channels: channelIds().map((id) => ({
          id,
          label: CHANNEL_META[id].label,
          bind: CHANNEL_META[id].bind,
          implemented: implementedChannels().includes(id),
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
