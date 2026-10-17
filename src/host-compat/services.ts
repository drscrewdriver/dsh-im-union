/**
 * 跨版本窄腰·服务探测收敛层。
 *
 * 全仓**唯一**允许出现 ctx.get / 服务面探测的地方（其余模块只吃这里冻结出的
 * capability 对象与显式接口）。纪律：
 * - 只 typeof/inject 探测，禁读宿主版本号；
 * - 未 inject 的服务**绝不能**直接读 ctx.<name>（Cordis 会当场抛错打挂宿主），
 *   一律走 optionalService 的 try/catch 软读；
 * - 探测结果一次求值、冻结成对象（WeakMap 按 ctx 缓存），禁每调用重探。
 */
import type { ConnectionLike, CordisLike, CredentialsLike, WebServerLike } from '../types.js'
import { detectSettingsGeneration } from './settings-compat.js'

export type SettingsGeneration = 'gen1' | 'gen2' | 'gen3'

export interface UnionCapabilities {
  /** 设置面代际：gen1=模块级 installSettingsSection（0.1.0/0.1.1）；gen2=ctx.settings.installSection（0.1.2~0.1.6）；gen3=volatile/configForms（0.1.7+）。 */
  settingsGeneration: SettingsGeneration
  /** 会话后端：native=agents+sessionController 可用；none=拒载降级（老线缺认证/会话控制接口的显式姿态）。 */
  sessionBackend: 'native' | 'none'
  credentials: CredentialsLike | undefined
  webServer: WebServerLike | undefined
  connection: ConnectionLike | undefined
  /** 宿主 configForms 服务（gen3 设置卡自动表单的软读入口）。 */
  configForms: unknown
  /** 文件上传服务（≥某线存在，逐线矩阵坐实后作为能力位而非版本判断）。 */
  fileUploads: unknown
  sessionPersistence: unknown
  agentPresets: unknown
  agentDefaultModel: unknown
  permissionPresets: unknown
  llm: unknown
  tools: unknown
  /** 宿主共享 fetch 通道（文件导出/回传 gate 的一半）。 */
  hasSharedFetch: boolean
  /** 管理面鉴权可用性：connection.requestRejection 存在才允许管理 API 上线。 */
  hasRequestRejection: boolean
}

const cache = new WeakMap<CordisLike, UnionCapabilities>()

/** 软读服务：ctx.get 缺失、未注册抛错、返回 undefined 一律归一为 undefined。 */
export function optionalService<T = unknown>(ctx: CordisLike, name: string): T | undefined {
  if (typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(name) as T | undefined
  } catch {
    // Cordis 对未注册服务抛错——静默即"该线没有这个面"，走降级。
    return undefined
  }
}

function isFunctionOn(value: unknown, key: string): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  )
}

/** 一次求值并冻结当前宿主能力快照。 */
export function detectCapabilities(ctx: CordisLike): UnionCapabilities {
  const hit = cache.get(ctx)
  if (hit !== undefined) return hit

  const agents = optionalService(ctx, 'agents')
  const sessionController = optionalService(ctx, 'sessionController')
  const workspaceController = optionalService(ctx, 'workspaceController')
  const credentials = optionalService<CredentialsLike>(ctx, 'credentials')
  const webServer = optionalService<WebServerLike>(ctx, 'webServer')
  const connection = optionalService<ConnectionLike>(ctx, 'connection')
  const configForms = optionalService(ctx, 'configForms')
  const fileUploads = optionalService(ctx, 'fileUploads')
  const sessionPersistence = optionalService(ctx, 'sessionPersistence')
  const agentPresets = optionalService(ctx, 'agentPresets')
  const agentDefaultModel = optionalService(ctx, 'agentDefaultModel')
  const permissionPresets = optionalService(ctx, 'permissionPresets')
  const llm = optionalService(ctx, 'llm')
  const tools = optionalService(ctx, 'tools')

  const nativeSession =
    isFunctionOn(agents, 'create') &&
    (isFunctionOn(sessionController, 'prompt') || isFunctionOn(workspaceController, 'follow'))

  const caps: UnionCapabilities = Object.freeze({
    settingsGeneration: detectSettingsGeneration(ctx),
    sessionBackend: nativeSession ? ('native' as const) : ('none' as const),
    credentials: isFunctionOn(credentials, 'set') && isFunctionOn(credentials, 'resolve') ? credentials : undefined,
    webServer: isFunctionOn(webServer, 'register') ? webServer : undefined,
    connection,
    configForms,
    fileUploads,
    sessionPersistence,
    agentPresets,
    agentDefaultModel,
    permissionPresets,
    llm,
    tools,
    hasSharedFetch: isFunctionOn(connection, 'createSharedFetchHandler'),
    hasRequestRejection: isFunctionOn(connection, 'requestRejection'),
  })
  cache.set(ctx, caps)
  return caps
}

/** 供非会话类服务（agents/sessionController 本体）的显式取用口。 */
export function sessionServices(ctx: CordisLike): { agents: unknown; sessionController: unknown; workspaceController: unknown } {
  return {
    agents: optionalService(ctx, 'agents'),
    sessionController: optionalService(ctx, 'sessionController'),
    workspaceController: optionalService(ctx, 'workspaceController'),
  }
}
