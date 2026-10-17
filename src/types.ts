/**
 * 净室外壳类型：本仓不 import 宿主包类型（编译自足、避免 devDeps 假绿），
 * 这里只声明 dsh-im-union 实际消费的宿主面的最小结构类型。
 * 一切运行时判定走 host-compat 的能力探测，禁止读宿主版本号。
 */

export interface LoggerLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface SettingsSectionHooks<T> {
  setSource(current: () => T): void
  onChange(): void
  validate?: (value: T) => void
}

/** ctx.settings 的跨代最小面：gen2 有 installSection；gen3 只剩 describe/update/mutate。 */
export interface SettingsServiceLike {
  installSection?: <T>(
    owner: CordisLike,
    namespace: unknown,
    schema: unknown,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ) => void
  describe?: () => ReadonlyArray<{ ns?: unknown; revision?: number }>
  update?: (namespace: string, patch: object, revision?: number) => Promise<void>
  mutate?: (
    namespace: string,
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
    revision?: number,
  ) => Promise<void>
}

export interface WebServerLike {
  register(def: {
    kind?: string
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): unknown | (() => void)
}

export interface ConnectionLike {
  requestRejection?: (request: { headers: import('node:http').IncomingHttpHeaders }) => 401 | 403 | undefined
  createSharedFetchHandler?: unknown
}

export interface CredentialsLike {
  set?: (ref: string, secret: string) => unknown | Promise<unknown>
  resolve?: (ref: string) => unknown | Promise<unknown>
  describe?: () => unknown | Promise<unknown>
  unset?: (ref: string) => unknown | Promise<unknown>
}

/** Cordis 上下文的最小结构面（各代并集，全部可缺）。 */
export interface CordisLike {
  logger(scope?: string): LoggerLike
  get?: (name: string) => unknown
  inject?: (names: string[], callback?: (services: Record<string, unknown>) => unknown) => unknown
  effect?: (fn: () => void | Promise<void> | (() => void | Promise<void>), name?: string) => void
  on?: (
    event: string,
    filter: unknown,
    handler: (...args: any[]) => void | Promise<void>,
    options?: { global?: boolean; prepend?: boolean },
  ) => () => void
  provide?: (name: string, impl: object, options?: object) => void
  settings?: SettingsServiceLike
  [key: string]: unknown
}