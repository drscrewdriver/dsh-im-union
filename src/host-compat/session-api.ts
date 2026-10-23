/**
 * 跨版本窄腰·会话 API。
 *
 * 主路径 = 宿主原生 agents + sessionController/workspaceController（im-connect 范式）。
 * 能力缺位（sessionBackend=none）时**显式抛 UnsupportedError**，由上层转成
 * "该宿主线不支持"的用户可见降级，而不是静默半死。
 * 各线参数契约差异（如 agents.create 单参/双参、0.1.5 显式传 Agent）在 M1
 * 用逐线契约测试坐实后在本文件内收敛，调用方不见版本差异。
 */
import type { CordisLike, LoggerLike } from '../types.js'
import { optionalService, sessionServices, type UnionCapabilities } from './services.js'

export class UnsupportedError extends Error {
  constructor(feature: string) {
    super(`dsh-im-union: 当前宿主缺少 ${feature} 接口，该能力已降级`)
    this.name = 'UnsupportedError'
  }
}

export interface SessionInfo {
  id: string
  title?: string
  running?: boolean
  /** 工作区位置（/workspaces 聚合键）。 */
  cwd?: string
  updatedAt?: number
}

/** 宿主 ModelCatalog 的宽松形（@0.2.x api/session-controller types 锚点，缺位即降级）。 */
export interface ModelCatalogLike {
  default?: { provider?: string; model?: string; reasoningEffort?: string }
  groups?: Array<{ id?: string; name?: string; models?: Array<{ id?: string; name?: string }> }>
  failures?: Array<{ id?: string; name?: string; message?: string }>
  routableProviders?: readonly string[]
}

export interface ModelSelectionInput {
  model: string
  provider?: string
  reasoningEffort?: string
}

export interface PresetInfo {
  id: string
  name: string
}

/** 权限预设选项（宿主 permissionPresets.optionOf 的宽松形）。 */
export interface PermissionOptionInfo {
  id: string
  name: string
  description?: string
}

export interface PermissionCatalogLike {
  options: PermissionOptionInfo[]
  /** 新会话的宿主默认预设（permissionPresets.defaultPreset）。 */
  default?: string
}

export interface CreateSessionOptions {
  workspace?: string
  /** 会话工作目录（sessionController.create 的 cwd；与 workspace 二选一，cwd 优先直传）。 */
  cwd?: string
  model?: string
  provider?: string
  reasoningEffort?: string
  preset?: string
  /**
   * 权限预设（宿主 permissionPresets.set(session, name)，webhook 范式：create
   * 拿到会话后同步应用一次；沙箱+审批旋钮随预设落位）。
   */
  permission?: string
  /** IM 侧生成的稳定会话 id（宿主 IM 约定 im: 前缀），宿主不接受时由实现方生成并回传。 */
  sessionIdHint?: string
  /**
   * 会话列表标题（T3.6 渠道 Logo 前缀，形如 `[TG] 帮我看看这份日志`）。
   * 宿主创建面**不收** title（锚点见 native 分支 createSession 注释），
   * 由本层在 create 成功后补一次 rename 落地；rename 面缺位/被拒即静默降级。
   */
  title?: string
}

export interface SessionApi {
  backend: 'native' | 'none'
  createSession(options: CreateSessionOptions): Promise<SessionInfo>
  prompt(sessionId: string, input: string | unknown[]): Promise<void>
  /** /steer 插话：宿主 prompt 面 mode:'steer'；面不可用返回 false（调用方转排队文案）。 */
  steer(sessionId: string, text: string): Promise<boolean>
  /** 订阅会话事件流；返回退订函数。 */
  follow(sessionId: string, onEvent: (event: unknown) => void): () => void
  cancel(sessionId: string): Promise<void>
  listSessions(workspace?: string): Promise<SessionInfo[]>
  selectModel(sessionId: string, selection: ModelSelectionInput): Promise<void>
  /** 模型目录；无面返回 undefined（/models 降级）。 */
  modelCatalog(): Promise<ModelCatalogLike | undefined>
  presetsList(): Promise<PresetInfo[]>
  presetSelect(nameOrId: string): Promise<{ ok: boolean; message?: string }>
  /** 权限预设目录（permissionPresets names+optionOf）；服务缺位返回 undefined（面板如实降级）。 */
  permissionCatalog(): Promise<PermissionCatalogLike | undefined>
  /** 对既有会话应用权限预设（sessions.get(id) + permissionPresets.set）；ok=false 带原因。 */
  applyPermission(sessionId: string, preset: string): Promise<{ ok: boolean; message?: string }>
  /** /fork：分叉当前会话，回新会话 id；无面抛 UnsupportedError（/ 命令层降级）。 */
  fork(sessionId: string): Promise<string>
  /** /rename：改会话标题；false=面缺位（不伪装成功）。 */
  rename(sessionId: string, title: string): Promise<boolean>
}

function asFn<T extends object>(value: unknown, key: string): T[keyof T] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const fn = (value as Record<string, unknown>)[key]
  return typeof fn === 'function' ? (fn as T[keyof T]) : undefined
}

/** apply 后再探测（惰性升级与诊断共用同一判据；services.ts 的 apply 期快照仅作初值）。 */
function sessionGate(services: { agents: unknown; sessionController: unknown; workspaceController: unknown }): boolean {
  return (
    asFn<{ create(...args: any[]): any }>(services.agents, 'create') !== undefined &&
    (asFn<{ prompt(...args: any[]): any }>(services.sessionController, 'prompt') !== undefined ||
      asFn<{ follow(...args: any[]): any }>(services.workspaceController, 'follow') !== undefined)
  )
}

/** apply 后任意时点重探会话后端（真机实证：desktop 线会话子系统晚于插件 apply 提供）。 */
export function probeSessionBackend(ctx: CordisLike): 'native' | 'none' {
  return sessionGate(sessionServices(ctx)) ? 'native' : 'none'
}

export function createSessionApi(ctx: CordisLike, caps: UnionCapabilities): SessionApi {
  if (caps.sessionBackend === 'native') {
    return createNativeSessionApi(ctx, sessionServices(ctx), caps)
  }
  return createLazySessionApi(ctx, caps)
}

/**
 * 惰性 none 面（desktop/Electron 线实证）：会话子系统可能**晚于插件 apply 提供**
 * ——不是"已提供未激活"（reflect 非严格读也拿不到），apply 期冻结探测必然误判
 * none 且永不恢复。本面每次访问 backend（引擎每回合、/session-catalog、/state
 * 都经此）重新软读；子系统一旦就绪立即升级原生面并粘住（服务提供后不消失）。
 */
function createLazySessionApi(ctx: CordisLike, caps: UnionCapabilities): SessionApi {
  let promoted: SessionApi | undefined
  const logger = typeof (ctx as { logger?: unknown }).logger === 'function'
    ? (ctx as unknown as { logger: (name: string) => LoggerLike }).logger('dsh-im-union')
    : undefined
  const tryPromote = (): SessionApi | undefined => {
    if (promoted !== undefined) return promoted
    const services = sessionServices(ctx)
    if (!sessionGate(services)) return undefined
    promoted = createNativeSessionApi(ctx, services, caps)
    if (logger !== undefined) logger.info('会话子系统已就绪：会话后端 none → native（惰性升级）')
    return promoted
  }
  return {
    get backend() {
      return tryPromote() !== undefined ? 'native' : 'none'
    },
    async createSession(options: CreateSessionOptions): Promise<SessionInfo> {
      const native = tryPromote()
      if (native !== undefined) return native.createSession(options)
      throw new UnsupportedError('agents/sessionController')
    },
    async prompt(sessionId: string, input: string | unknown[]): Promise<void> {
      const native = tryPromote()
      if (native !== undefined) return native.prompt(sessionId, input)
      throw new UnsupportedError('sessionController.prompt')
    },
    async steer(sessionId: string, text: string): Promise<boolean> {
      const native = tryPromote()
      return native !== undefined ? native.steer(sessionId, text) : false
    },
    follow(sessionId: string, onEvent: (event: unknown) => void): () => void {
      const native = tryPromote()
      if (native !== undefined) return native.follow(sessionId, onEvent)
      throw new UnsupportedError('session follow')
    },
    async cancel(sessionId: string): Promise<void> {
      const native = tryPromote()
      if (native !== undefined) return native.cancel(sessionId)
      throw new UnsupportedError('session cancel')
    },
    async listSessions(workspace?: string): Promise<SessionInfo[]> {
      const native = tryPromote()
      return native !== undefined ? native.listSessions(workspace) : []
    },
    async selectModel(sessionId: string, selection: ModelSelectionInput): Promise<void> {
      const native = tryPromote()
      if (native !== undefined) return native.selectModel(sessionId, selection)
      throw new UnsupportedError('model selection')
    },
    async modelCatalog(): Promise<ModelCatalogLike | undefined> {
      const native = tryPromote()
      return native !== undefined ? native.modelCatalog() : undefined
    },
    async presetsList(): Promise<PresetInfo[]> {
      const native = tryPromote()
      return native !== undefined ? native.presetsList() : []
    },
    async presetSelect(nameOrId: string): Promise<{ ok: boolean; message?: string }> {
      const native = tryPromote()
      return native !== undefined ? native.presetSelect(nameOrId) : { ok: false, message: '当前宿主无预设面' }
    },
    async permissionCatalog() {
      const native = tryPromote()
      return native !== undefined ? native.permissionCatalog() : undefined
    },
    async applyPermission(sessionId: string, preset: string): Promise<{ ok: boolean; message?: string }> {
      const native = tryPromote()
      return native !== undefined
        ? native.applyPermission(sessionId, preset)
        : { ok: false, message: '会话后端未就绪，权限预设暂不可应用' }
    },
    async fork(sessionId: string): Promise<string> {
      const native = tryPromote()
      if (native !== undefined) return native.fork(sessionId)
      throw new UnsupportedError('session fork')
    },
    async rename(sessionId: string, title: string): Promise<boolean> {
      const native = tryPromote()
      return native !== undefined ? native.rename(sessionId, title) : false
    },
  }
}

function createNativeSessionApi(
  ctx: CordisLike,
  services: { agents: unknown; sessionController: unknown; workspaceController: unknown },
  caps: UnionCapabilities,
): SessionApi {
  const { agents, sessionController, workspaceController } = services
  const sessionPersistence = optionalService(ctx, 'sessionPersistence')
  // 预设服务双源：惰性升级路径下 apply 期快照可能还没它，运行时软读优先；
  // 原生首发路径（测试契约）回退 caps 快照。
  const agentPresets = optionalService(ctx, 'agentPresets') ?? caps.agentPresets
  const create = asFn<{ create(...args: any[]): any }>(agents, 'create')!
  const promptFn = asFn<{ prompt(...args: any[]): any }>(sessionController, 'prompt')
  const followFn = asFn<{ follow(...args: any[]): any }>(sessionController, 'follow')
  const cancelFn = asFn<{ cancel(...args: any[]): any }>(sessionController, 'cancel')
  const listFn = asFn<{ list(...args: any[]): any }>(sessionPersistence, 'list')
  const wfFollowFn = asFn<{ follow(...args: any[]): any }>(workspaceController, 'follow')
  const sessionListFn = asFn<{ list(...args: any[]): any }>(sessionController, 'list')
  const selectModelFn = asFn<{ selectModel(...args: any[]): any }>(sessionController, 'selectModel')
  const catalogFn = asFn<{ modelCatalog(...args: any[]): any }>(sessionController, 'modelCatalog')
  const sessionCreateFn = asFn<{ create(...args: any[]): any }>(sessionController, 'create')
  const presetsListFn = asFn<{ list(...args: any[]): any }>(agentPresets, 'list')
  const presetSelectFn = asFn<{ select(...args: any[]): any }>(agentPresets, 'select')
  const forkFn = asFn<{ fork(...args: any[]): any }>(sessionController, 'fork')
  const renameFn = asFn<{ rename(...args: any[]): any }>(sessionController, 'rename')
  const log = typeof (ctx as { logger?: unknown }).logger === 'function'
    ? (ctx as unknown as { logger: (name: string) => LoggerLike }).logger('dsh-im-union')
    : { warn() {}, info() {}, debug() {}, error() {} }

  /**
   * 形态归一：宿主 @Remote 面收 request 对象（@0.2.x 锚点 api/session-controller），
   * 老线/位置参变体作为运行时回退——探测不了的形态差异用调用试探+回退收敛，
   * 两形都失败时抛首错（保留真实错误面供矩阵取证）。
   */
  async function callWithShapeFallback<T>(
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await primary()
    } catch (firstError) {
      try {
        return await fallback()
      } catch {
        throw firstError
      }
    }
  }

  /**
   * 0.2.x 线 @Remote 面（desktop 真机实证）：prompt(request, signal) 进门即
   * `signal.throwIfAborted()`（index.ts:346-349），list(page) 同收 signal——
   * 缺参直接 TypeError。本插件无调用方取消语义，每次调用配一个新信号即可。
   */
  const freshSignal = (): AbortSignal => new AbortController().signal

  function promptRequest(sessionId: string, mode: 'queue' | 'steer', input: string | unknown[]): Record<string, unknown> {
    const content =
      typeof input === 'string'
        ? [{ type: 'text', text: input }]
        : Array.isArray(input)
          ? input
          : [{ type: 'text', text: String(input) }]
    let clientTimeZone: string | undefined
    try {
      clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
    } catch {
      clientTimeZone = undefined
    }
    return {
      sessionId,
      mode,
      content,
      requestId: `imu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ...(clientTimeZone !== undefined ? { clientTimeZone } : {}),
    }
  }

  /**
   * 权限预设落地面：sessions.get(id) 取活会话 → permissionPresets.set。
   * 宿主锚点：packages/interaction/permission-presets（set 记 permission/preset
   * 事件并写穿 sandbox/mode + approval/policy 旋钮；未知预设名抛错）+
   * core/session SessionStore.get(id)。服务缺位/会话不在册都回 ok:false，
   * 不伪装成功。
   */
  async function applyPermissionById(sessionId: string, preset: string): Promise<{ ok: boolean; message?: string }> {
    const sessionsSvc = optionalService(ctx, 'sessions')
    const permissionPresets = optionalService(ctx, 'permissionPresets')
    const getFn = asFn<{ get(id: string): unknown }>(sessionsSvc, 'get')
    const setFn = asFn<{ set(session: unknown, name: string): void }>(permissionPresets, 'set')
    if (permissionPresets === undefined || getFn === undefined || setFn === undefined) {
      return { ok: false, message: '宿主未提供权限预设面' }
    }
    const session = getFn.call(sessionsSvc, sessionId)
    if (session === undefined || session === null) return { ok: false, message: '会话不存在或未激活' }
    try {
      setFn.call(permissionPresets, session, preset)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: `权限预设应用失败：${(error as Error).message}` }
    }
  }

  /**
   * title 落地面（rename）：request 对象形优先，位置参形回退；
   * 面缺位或被拒回 false（调用方不伪装列表可见）。
   * 宿主锚点：packages/api/session-controller/src/types.ts:289-292（SessionRenameRequest
   * 收 title）+ src/index.ts:325（@Remote('rename')）+ src/commands.ts:176-190（实现）。
   */
  async function renameTitle(sessionId: string, title: string): Promise<boolean> {
    if (!renameFn) return false
    try {
      await callWithShapeFallback(
        () => renameFn.call(sessionController, { sessionId, title }) as Promise<void>,
        () => renameFn.call(sessionController, sessionId, title) as Promise<void>,
      )
      return true
    } catch {
      return false
    }
  }

  return {
    backend: 'native',
    async createSession(options) {
      // title 面查实（宿主 0.2.x 线源码锚点，本仓 dsh-repo 对照）：
      // - packages/api/session-controller/src/types.ts:265-270 SessionCreateRequest =
      //   {workspaceId?, cwd?, sessionId?, agentPreset?}——**无 title 字段**；
      // - 主路径走 sessionController.create（cwd 直接落 Agent 项目目录、sessionIdHint
      //   幂等采纳、agentPreset 建会话即装），锚点 commands.ts:87-129；
      // - 老线/主路径被拒（如预设不存在）→ 回退 agents.create meta 路径（仅 origin/
      //   workspace 白名单，锚点 packages/core/agent/src/index.ts:78-85），不伪称偏好已生效；
      // - 唯一 title 面 = sessionController.rename（types.ts:289-292）→ create+rename 两步。
      const wanted = typeof options.title === 'string' ? options.title.trim() : ''
      const applyModelSelection = async (id: string): Promise<void> => {
        if (options.model === undefined || options.model === '') return
        if (typeof selectModelFn !== 'function') {
          log.warn('模型选择面缺位，账号级模型偏好未生效')
          return
        }
        try {
          await callWithShapeFallback(
            () =>
              selectModelFn.call(sessionController, {
                sessionId: id,
                ...(options.provider !== undefined && options.provider !== '' ? { provider: options.provider } : {}),
                model: options.model,
                ...(options.reasoningEffort !== undefined && options.reasoningEffort !== ''
                  ? { reasoningEffort: options.reasoningEffort }
                  : {}),
              }) as Promise<void>,
            () => selectModelFn.call(sessionController, id, options.model) as Promise<void>,
          )
        } catch (error) {
          log.warn(`模型偏好落位失败（会话照常创建）: ${(error as Error).message}`)
        }
      }
      const renameIfWanted = async (id: string): Promise<SessionInfo> => {
        if (wanted !== '') {
          const applied = await renameTitle(id, wanted)
          if (applied) return { id, title: wanted }
        }
        return { id }
      }
      const applyPermissionPref = async (id: string): Promise<void> => {
        if (options.permission === undefined || options.permission === '') return
        const verdict = await applyPermissionById(id, options.permission)
        if (!verdict.ok) log.warn(`权限预设未生效（会话照常创建）: ${verdict.message ?? ''}`)
      }

      if (typeof sessionCreateFn === 'function') {
        const request: Record<string, unknown> = {}
        if (options.sessionIdHint !== undefined && options.sessionIdHint.startsWith('im:')) {
          // 显式 id 走宿主幂等采纳（commands.ts:98 sessionId ?? brandString）。
          request.sessionId = options.sessionIdHint
        }
        if (options.cwd !== undefined && options.cwd !== '') {
          request.cwd = options.cwd
        } else if (options.workspace !== undefined && options.workspace !== '') {
          request.workspaceId = options.workspace
        }
        if (options.preset !== undefined && options.preset !== '') request.agentPreset = options.preset
        try {
          const value = (await sessionCreateFn.call(sessionController, request)) as unknown
          const id =
            value !== null && typeof value === 'object' && typeof (value as { sessionId?: unknown }).sessionId === 'string'
              ? (value as { sessionId: string }).sessionId
              : options.sessionIdHint
          if (id === undefined) throw new Error('session.create 回包无 sessionId')
          await applyModelSelection(id)
          await applyPermissionPref(id)
          const info = await renameIfWanted(id)
          if (options.sessionIdHint !== undefined && id !== options.sessionIdHint) {
            // 宿主采纳了别的 id 形态（规范化/碰撞回退）——交由调用方 router.bind 落新绑定。
            log.info(`session.create 采纳新 id: ${options.sessionIdHint} -> ${id}`)
          }
          return info
        } catch (error) {
          log.warn(`sessionController.create 被拒，回退 agents.create: ${(error as Error).message}`)
        }
      }

      const created = await create.call(agents, {
        seed: [],
        meta: { origin: 'dsh-im-union', workspace: options.workspace },
      })
      const id: string =
        (created && typeof created.sessionId === 'string' && created.sessionId) ||
        (created && typeof created.id === 'string' && created.id) ||
        options.sessionIdHint ||
        `im:union:generated:${Date.now()}`
      await applyModelSelection(id)
      await applyPermissionPref(id)
      const info = await renameIfWanted(id)
      if (info.title !== undefined) return info
      const title = created && typeof created.title === 'string' ? created.title : undefined
      return { id, title }
    },
    async prompt(sessionId, input) {
      if (!promptFn) throw new UnsupportedError('sessionController.prompt')
      const request = promptRequest(sessionId, 'queue', input)
      await callWithShapeFallback(
        () => promptFn.call(sessionController, request, freshSignal()) as Promise<void>,
        () => promptFn.call(sessionController, sessionId, input) as Promise<void>,
      )
    },
    async steer(sessionId, text) {
      if (!promptFn) return false
      const request = promptRequest(sessionId, 'steer', text)
      try {
        await callWithShapeFallback(
          () => promptFn.call(sessionController, request, freshSignal()) as Promise<void>,
          () => promptFn.call(sessionController, sessionId, [{ type: 'text', text }]) as Promise<void>,
        )
        return true
      } catch {
        // mode:'steer' 面不存在/被拒：调用方转排队提示，不伪装成功。
        return false
      }
    },
    follow(sessionId, onEvent) {
      // 0.2.x 线（desktop 真机实证）：follow({address}, signal) → AsyncIterable<帧>，
      // 帧三种——snapshot（忽略，防重放旧文）/event（取 .event 投喂）/assistant-stream
      // （Web 呈现专用，忽略）；旧线 follow(sessionId, onEvent) → 退订函数。
      // 运行时探测收敛：新形态返回异步迭代器即泵帧，否则落旧形态。
      const fn = followFn ?? wfFollowFn
      if (!fn) throw new UnsupportedError('session follow')
      const target = followFn ? sessionController : workspaceController
      if (followFn !== undefined) {
        let probe: unknown
        try {
          probe = fn.call(target, { address: { kind: 'session', sessionId } }, freshSignal())
        } catch {
          probe = undefined
        }
        if (
          probe !== null &&
          typeof probe === 'object' &&
          Symbol.asyncIterator in (probe as Record<PropertyKey, unknown>)
        ) {
          const pump = new AbortController()
          void (async () => {
            try {
              for await (const raw of probe as AsyncIterable<unknown>) {
                if (pump.signal.aborted) break
                const frame = raw as { type?: string; event?: unknown }
                if (frame?.type === 'event' && frame.event !== undefined) onEvent(frame.event)
              }
            } catch (error) {
              if (!pump.signal.aborted) log.warn(`follow 事件流中断: ${(error as Error).message}`)
            }
          })()
          return () => pump.abort()
        }
        // probe 非流（老线被静默拒绝/返回杂项）→ 落旧形态以正确实参重试；
        // 不信任 probe 的函数返回值——老线真退订必须配旧线实参才有意义。
      }
      const ret = fn.call(target, sessionId, onEvent)
      if (typeof ret === 'function') return ret as () => void
      return () => undefined
    },
    async cancel(sessionId) {
      if (!cancelFn) throw new UnsupportedError('session cancel')
      await callWithShapeFallback(
        () => cancelFn.call(sessionController, { sessionId }) as Promise<void>,
        () => cancelFn.call(sessionController, sessionId) as Promise<void>,
      )
    },
    async listSessions(workspace) {
      // 首选 sessionController.list（摘要带 running/cwd，命令面需要），缺位退 sessionPersistence.list。
      if (sessionListFn) {
        const value = (await sessionListFn.call(
          sessionController,
          workspace !== undefined && workspace !== '' ? { workspace } : {},
          freshSignal(),
        )) as unknown
        const items = value !== null && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
          ? (value as { items: unknown[] }).items
          : Array.isArray(value)
            ? value
            : []
        return items
          .map((row): SessionInfo | undefined => {
            if (row === null || typeof row !== 'object') return undefined
            const r = row as Record<string, unknown>
            const id = typeof r.sessionId === 'string' ? r.sessionId : typeof r.id === 'string' ? r.id : undefined
            if (id === undefined) return undefined
            // 标题两级提取（Phase 6 task_19，参考 chat-commands.ts:17）：
            // 宿主 list 行标题在 projections.values.title，r.title 可能为空。
            const projTitle = (r.projections as Record<string, unknown> | undefined)?.values as Record<string, unknown> | undefined
            const resolvedTitle = typeof projTitle?.title === 'string' && projTitle.title !== '' ? projTitle.title : typeof r.title === 'string' && r.title !== '' ? r.title : undefined
            return {
              id,
              title: resolvedTitle,
              running: typeof r.running === 'boolean' ? r.running : undefined,
              cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
              updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : undefined,
            }
          })
          .filter((row): row is SessionInfo => row !== undefined)
      }
      if (!listFn) return []
      const rows = (await listFn.call(sessionPersistence, workspace)) as unknown
      if (!Array.isArray(rows)) return []
      return rows
        .map((row): SessionInfo | undefined => {
          if (row !== null && typeof row === 'object') {
            const r = row as Record<string, unknown>
            const id = typeof r.id === 'string' ? r.id : typeof r.sessionId === 'string' ? r.sessionId : undefined
            if (id === undefined) return undefined
            return { id, title: typeof r.title === 'string' ? r.title : undefined }
          }
          return undefined
        })
        .filter((row): row is SessionInfo => row !== undefined)
    },
    async selectModel(sessionId, selection) {
      if (!selectModelFn) throw new UnsupportedError('model selection')
      await callWithShapeFallback(
        () => selectModelFn.call(sessionController, { sessionId, ...selection }) as Promise<void>,
        () => selectModelFn.call(sessionController, sessionId, selection.model) as Promise<void>,
      )
    },
    async modelCatalog() {
      if (!catalogFn) return undefined
      try {
        const catalog = await catalogFn.call(sessionController)
        return catalog !== null && typeof catalog === 'object' ? (catalog as ModelCatalogLike) : undefined
      } catch {
        return undefined
      }
    },
    async presetsList() {
      if (!presetsListFn) return []
      try {
        const value = await presetsListFn.call(agentPresets)
        const rows =
          Array.isArray(value) ? value : value !== null && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : []
        return rows
          .map((row): PresetInfo | undefined => {
            if (row === null || typeof row !== 'object') return undefined
            const r = row as Record<string, unknown>
            const id = typeof r.id === 'string' ? r.id : typeof r.name === 'string' ? r.name : undefined
            if (id === undefined) return undefined
            return { id, name: typeof r.name === 'string' ? r.name : id }
          })
          .filter((row): row is PresetInfo => row !== undefined)
      } catch {
        return []
      }
    },
    async presetSelect(nameOrId) {
      if (!presetSelectFn) return { ok: false, message: '当前宿主无预设选择面' }
      try {
        await presetSelectFn.call(agentPresets, { id: nameOrId })
        return { ok: true }
      } catch (error) {
        try {
          await presetSelectFn.call(agentPresets, nameOrId)
          return { ok: true }
        } catch {
          return { ok: false, message: `预设切换失败：${(error as Error).message}` }
        }
      }
    },
    async permissionCatalog() {
      // 每次软读：permissionPresets 可能晚于本面升级才就绪（desktop 线实证）。
      const permissionPresets = optionalService(ctx, 'permissionPresets')
      if (permissionPresets === undefined) return undefined
      try {
        const names = (permissionPresets as { names?: unknown }).names
        if (!Array.isArray(names)) return undefined
        const optionOf = asFn<{ optionOf(name: string): unknown }>(permissionPresets, 'optionOf')
        const options: PermissionOptionInfo[] = names
          .filter((n): n is string => typeof n === 'string' && n !== '')
          .map((n) => {
            const opt = optionOf !== undefined ? (optionOf.call(permissionPresets, n) as unknown) : undefined
            const row = opt !== null && typeof opt === 'object' ? (opt as Record<string, unknown>) : undefined
            return {
              id: n,
              name: typeof row?.name === 'string' && row.name !== '' ? row.name : n,
              ...(typeof row?.description === 'string' && row.description !== '' ? { description: row.description } : {}),
            }
          })
        const def = (permissionPresets as { defaultPreset?: unknown }).defaultPreset
        return { options, ...(typeof def === 'string' && def !== '' ? { default: def } : {}) }
      } catch {
        return undefined
      }
    },
    async applyPermission(sessionId: string, preset: string) {
      return applyPermissionById(sessionId, preset)
    },
    async fork(sessionId) {
      if (!forkFn) throw new UnsupportedError('session fork')
      const result = await callWithShapeFallback(
        () => forkFn.call(sessionController, { sessionId, requestId: `imu-f-${Date.now().toString(36)}` }) as Promise<unknown>,
        () => forkFn.call(sessionController, sessionId) as Promise<unknown>,
      )
      // 回包形收敛：新会话 id 可能在顶层或嵌 session/descriptor；拿不到即缺位。
      if (typeof result === 'string') return result
      if (result !== null && typeof result === 'object') {
        const r = result as Record<string, unknown>
        for (const key of ['sessionId', 'id']) {
          if (typeof r[key] === 'string') return r[key] as string
        }
        const nested = (r.session ?? r.descriptor ?? r.forked) as Record<string, unknown> | undefined
        if (nested !== null && typeof nested === 'object') {
          for (const key of ['sessionId', 'id']) {
            if (typeof nested[key] === 'string') return nested[key] as string
          }
        }
      }
      throw new UnsupportedError('fork 回包无新会话 id')
    },
    async rename(sessionId, title) {
      return renameTitle(sessionId, title)
    },
  }
}
