/**
 * dsh-im-union 宿主入口。
 *
 * 顶层 inject 只放必然存在的服务（webServer——web profile 的锚）；
 * 其余全部经 host-compat/services.ts 软读冻结成 capability。
 * 这是"装不上"与"装上静默失效"的分界：硬 inject 缺失服务 = Cordis 载入即抛，
 * 硬 inject 已删服务（settingsScope 类）= client 半永不 apply 且无红字。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CordisLike } from './types.js'
import { detectCapabilities } from './host-compat/services.js'
import { createSessionApi } from './host-compat/session-api.js'
import { attachInteraction } from './host-compat/interaction.js'
import { createVault, credentialRef } from './credentials/vault.js'
import { registerAdminApi } from './admin/api.js'
import { ChatRouter } from './engine/router.js'
import { ImUnionEngine } from './engine/gateway.js'
import { CHANNEL_META, channelIds } from './channels/meta.js'
import { implementedChannels, registerChannel, createAdapter } from './channels/registry.js'
import { PLUGIN_NAME } from './host-compat/session-source.js'

export const name = PLUGIN_NAME

/** 只 inject 必然存在的服务；可选服务在 services.ts 软读。 */
export const inject = ['webServer']

export interface UnionPluginConfig {
  stateDir: string
}

/** 账号登记（T1.8 设置页落地前的文件态；secret 只存 credentialRef 指向的凭据库）。 */
interface AccountRecord {
  accountId: string
  channel: string
  config?: Record<string, string>
  dmAllowlist?: string[]
  groupEnabled?: boolean
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

  // 渠道工厂懒加载：只有 accounts.json 真配了该渠道才会动态 import 适配器模块。
  registerChannel('telegram', async (options) => (await import('./channels/telegram.js')).createTelegramAdapter(options))

  // M1 起步引导：文件态账号登记→凭据库解 secret→建适配器→入引擎→连接。
  // 账号 CRUD/扫码配对归 T1.8，管理面 POST 不在此处越界。
  const accountsFile = join(stateDir, 'accounts.json')
  void (async () => {
    if (!existsSync(accountsFile)) return
    let records: AccountRecord[]
    try {
      const parsed = JSON.parse(readFileSync(accountsFile, 'utf8')) as unknown
      records = Array.isArray(parsed) ? (parsed as AccountRecord[]) : []
    } catch (error) {
      log.warn(`accounts.json 解析失败，跳过账号引导: ${(error as Error).message}`)
      return
    }
    for (const record of records) {
      const meta = CHANNEL_META[record.channel]
      if (meta === undefined || !implementedChannels().includes(record.channel)) continue
      try {
        const secrets: Record<string, string | undefined> = {}
        for (const field of meta.fields.filter((f) => f.secret)) {
          secrets[field.key] = await vault.resolve(credentialRef(record.channel, `${record.accountId}.${field.key}`))
        }
        const adapter = await createAdapter(record.channel, {
          accountId: record.accountId,
          config: record.config ?? {},
          secrets,
        })
        engine.registerAccount(adapter, record.accountId, {
          dmAllowlist: new Set(record.dmAllowlist ?? []),
          groupEnabled: record.groupEnabled ?? true,
        })
        await adapter.connect()
        log.info(`渠道 ${record.channel} 账号 ${record.accountId} 已连接`)
      } catch (error) {
        log.warn(`渠道 ${record.channel} 账号 ${record.accountId} 启动失败: ${(error as Error).message}`)
      }
    }
  })()

  // M0 管理面：只读探针。账号 CRUD / 扫码配对 / 连接诊断随 M1 渠道层落地。
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
        })),
      })
    },
  })

  // M0 先占审批/提问的接管位（handler 在 M1 接通渠道）：
  // prepend 订阅保证网页 UI 之前拿到请求，杜绝"审批被网页先消费、IM 侧静默"。
  const detachInteraction = attachInteraction(ctx, {})

  const dispose = ctx.effect?.(() => {
    return () => {
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
