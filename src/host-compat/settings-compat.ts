/**
 * 跨版本窄腰·设置面三态分派（gen1/gen2/gen3）。
 *
 * 机制对标自有仓库先例（reffer-dsh-plugins/dsh-agency-agents/src/settings-compat.ts
 * 的三态分派 + dsh-tidy-display 的 volatileField/configFormsOf 探测），本文件为
 * dsh-im-union 独立实现。铁律：
 * - 只 typeof 探测，禁读宿主版本号；
 * - gen1 的模块级助手必须从**宿主安装位置**解析（bin 符号链接 / prefix/lib 双锚点），
 *   插件自己的 node_modules 可能更旧，不能用来判断当前宿主；
 * - gen3 不写命令式注册码：Config 字段标 volatile + 宿主 configForms 自动出表单。
 */
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { CordisLike, SettingsSectionHooks } from '../types.js'

export type SettingsGeneration = 'gen1' | 'gen2' | 'gen3'

type NamespaceFactory = (value: string) => unknown

function moduleExport(module: object, name: string): unknown {
  return (module as Record<string, unknown>)[name]
}

/** 0.1.2-alpha.2 起 settingsNamespace 助手被删、命名空间退化为裸字符串——两路并取。 */
export function settingsNamespaceCompat(value: string, module: object = {}): unknown {
  const legacy = moduleExport(module, 'settingsNamespace')
  return typeof legacy === 'function' ? (legacy as NamespaceFactory)(value) : value
}

function missingHostModule(specifier: string): NodeJS.ErrnoException {
  const error = new Error(`Cannot find module '${specifier}'`) as NodeJS.ErrnoException
  error.code = 'MODULE_NOT_FOUND'
  return error
}

/** 宿主 bin 可能是符号链接，或停在 prefix/bin，模块实际在 prefix/lib/node_modules。 */
function hostModuleAnchors(entry: string): string[] {
  const resolved = resolve(entry)
  const anchors = [resolved]
  try {
    const real = realpathSync(resolved)
    if (real !== resolved) anchors.push(real)
  } catch {
    // 垫片路径不一定是已存在的文件，继续按安装布局找。
  }
  const dir = dirname(resolved)
  anchors.push(
    join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  )
  return anchors
}

function hostRequireFor(specifier: string, entry = process.argv[1]): NodeRequire | undefined {
  if (entry === undefined || entry === '') return undefined
  for (const anchor of hostModuleAnchors(entry)) {
    try {
      const hostRequire = createRequire(anchor)
      hostRequire.resolve(specifier)
      return hostRequire
    } catch {
      // 换下一个锚点。
    }
  }
  return undefined
}

/** 从当前宿主安装位置加载模块；解析不到返回 undefined（不回退到插件自己的依赖）。 */
export function loadHostModule(specifier: string, entry = process.argv[1]): unknown {
  const hostRequire = hostRequireFor(specifier, entry)
  if (hostRequire === undefined) throw missingHostModule(specifier)
  return hostRequire(specifier)
}

let hostSettingsModule: object | undefined

function settingsModuleFromHost(): object {
  if (hostSettingsModule !== undefined) return hostSettingsModule
  try {
    hostSettingsModule = loadHostModule('@deepseek-ai/dsh-settings') as object
  } catch {
    hostSettingsModule = {}
  }
  return hostSettingsModule
}

function hasGen2Install(ctx: CordisLike): boolean {
  return typeof ctx.settings?.installSection === 'function'
}

function hasGen1Install(module: object = settingsModuleFromHost()): boolean {
  return typeof moduleExport(module, 'installSettingsSection') === 'function'
}

/**
 * 代际判定顺序（与 VD 台账一致）：
 * gen2 = ctx.settings.installSection（0.1.2~0.1.6）→
 * gen1 = 宿主模块级 installSettingsSection（0.1.0/0.1.1）→
 * gen3 = 两者皆无（0.1.7+/0.2.x，命令式注册已删，走 volatile 声明式）。
 */
export function detectSettingsGeneration(ctx: CordisLike, module?: object): SettingsGeneration {
  if (hasGen2Install(ctx)) return 'gen2'
  if (hasGen1Install(module ?? settingsModuleFromHost())) return 'gen1'
  return 'gen3'
}

/**
 * gen1/gen2 的节注册入口；gen3 到达此处属于调用方分派错误（gen3 不写注册码），
 * 抛错暴露问题——静默吞掉就是"卡片头有但表单空白"的温床。
 */
export function installSettingsSectionCompat<T>(
  ctx: CordisLike,
  namespace: unknown,
  schema: unknown,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  if (typeof ctx.settings?.installSection === 'function') {
    // gen2 硬规：base 必须先 resolveConfig，否则 ValidationError: expected string...
    ctx.settings.installSection(ctx, namespace, schema, entry, hooks)
    return
  }
  const legacy = moduleExport(settingsModuleFromHost(), 'installSettingsSection')
  if (typeof legacy === 'function') {
    ;(legacy as (ctx: CordisLike, ns: unknown, schema: unknown, entry: T, hooks: SettingsSectionHooks<T>) => void)(
      ctx,
      namespace,
      schema,
      entry,
      hooks,
    )
    return
  }
  throw new Error(
    'settings-compat: 当前宿主无命令式设置节注册（gen3 应走 volatile 声明式），调用方分派错误',
  )
}

/** gen3 探测标注：≤0.1.6 的 schemastery 没有 .volatile()，方法存在才链式。 */
export function volatileField<F extends object>(field: F): F {
  const volatile = moduleExport(field as object, 'volatile')
  return typeof volatile === 'function' ? ((volatile as () => F).call(field) as F) : field
}

/** gen3 的 configForms 服务软读（老线无此服务 → undefined，只留 persist key）。 */
export function configFormsOf(ctx: CordisLike): unknown {
  if (typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get('configForms')
  } catch {
    return undefined
  }
}

/** 0.1.7 的 volatile 配置字段是带 get() 的稳定引用，读取时必须取当前快照。 */
export function isLiveValue(value: unknown): value is { get(): unknown } {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
}

export function unwrapLive(value: unknown): unknown {
  return isLiveValue(value) ? value.get() : value
}
