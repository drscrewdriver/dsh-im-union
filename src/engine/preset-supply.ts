/**
 * IM 简洁预设（0.4.6）：运行时向宿主 `agentPresets` 注册 `im-concise` 预设，
 * 作为 IM 会话的缺省 agent 组合（账号级 agentPreset 优先）。
 *
 * 为什么走预设层（架构事实）：
 * - 插件之间无法互相抑制 prompt 注入——genui 的 ```dsh-ui 教学、raw-html-v2 的
 *   裸 HTML 引导都是各自往请求里加的段；
 * - `persona.complete: true`（完整系统提示模式）让全局身份/工具引导/后续装配监听
 *   一律无法追加 prompt 文本 —— 这是「屏蔽结构体表现欲」的正解；
 * - persona 属系统提示：不随对话轮次累积、可命中 prompt cache，比每回合在用户
 *   消息里拼纪律前缀省得多（用户裁定：不要每回合提示）。
 *
 * 为什么用 register 而不是 `.agent-presets/` 目录（宿主文档实读）：
 * - `packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md`
 *   明写：目录形态已被 declaration rows 取代，「Nothing reads that directory any more」；
 * - declaration row 要写进 bundle patch，对不含 `dsh-agent-preset` 包的老宿主
 *   （0.1.x 线）有挂载失败风险；
 * - `agentPresets.register(definition)` 是服务面运行时注册：软读缺位即整体降级，
 *   跨版本安全，注册失败不拦插件装载。
 */

/** 插件内置预设 id（IM 会话缺省 agentPreset）。 */
export const IM_PRESET_ID = 'im-concise'

/** IM 输出纪律（persona 完整模式的系统提示正文）。 */
export const IM_PERSONA_PREFIX = [
  'You are a concise assistant replying through an IM chat (WeChat, Telegram, etc.).',
  'Hard rules for every reply:',
  '1) Prefer short plain text. Lead with the conclusion. Keep replies under ~800 characters',
  '   unless the user explicitly asks for detail.',
  '2) Never emit rich structures: no ```dsh-ui fences, no ```html fences, no bare HTML tags',
  '   (<div>, <vcp-root>, <style> ...), no component JSON. The IM client renders only plain',
  '   text and images; anything else arrives as source noise.',
  '3) When a chart or diagram is truly needed, emit exactly ONE ```svg fence containing a',
  '   complete inline <svg> (white background, dark foreground, responsive viewBox, width',
  '   <= 1000). The bridge plugin converts it into an image and sends it separately.',
  '4) No repetitive explanations, no small-talk padding; do not paste large code blocks',
  '   unless the user asks for them.',
].join('\n')

/**
 * 预设定义（宿主 PresetDefinition 的宽松形：id + plugins 必填，name/description/order 可选）。
 * 工具集对齐宿主 `simple-reply` 先例：持久 bash + 本地文件编辑，IM 场景够用即可。
 */
export function imPresetDefinition(): Record<string, unknown> {
  return {
    id: IM_PRESET_ID,
    name: 'IM concise',
    description: 'IM 渠道专用：简短纯文字优先；persona 完整模式阻断富结构引导；图表走 svg 围栏由 dsh-im-union 转图发送。',
    order: 90,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: {
          prefix: IM_PERSONA_PREFIX,
          complete: true,
          includeRuntimeContext: false,
        },
      },
      {
        id: 'persistent-shell',
        name: 'cordis:group',
        group: true,
        isolate: { terminals: true },
        config: [
          { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
          {
            id: 'persistent-bash',
            name: '@deepseek-ai/dsh-tool-bash-persistent',
            config: { timeoutMs: 300000 },
          },
        ],
      },
      {
        id: 'filesystem',
        name: 'cordis:group',
        group: true,
        isolate: { fs: true },
        config: [
          {
            id: 'fs-local',
            name: '@deepseek-ai/dsh-fs-local',
            config: { cwd: process.env.DSH_CWD ?? process.cwd() },
          },
          {
            id: 'str-replace-editor',
            name: '@deepseek-ai/dsh-tool-str-replace-editor',
            config: { maxOutputChars: 16000 },
          },
        ],
      },
    ],
  }
}

/** 宿主 agentPresets 服务面的宽松形（register 缺位=老宿主，整体降级）。 */
export interface AgentPresetsLike {
  register?: (definition: Record<string, unknown>) => unknown
}

export interface RegisterPresetResult {
  ok: boolean
  /** 已注册（或撞 Duplicate 视为已在册）时的 disposer；调用方挂到插件卸载钩子。 */
  dispose?: () => Promise<void> | void
  reason?: string
}

/**
 * 注册 IM 预设。返回 ok=false 表示宿主无该面/注册失败——调用方保持「不指定预设」降级。
 * Duplicate（插件热重载）视为成功：预设已在册。
 */
export async function registerImPreset(agentPresets: AgentPresetsLike | undefined): Promise<RegisterPresetResult> {
  if (agentPresets === undefined || typeof agentPresets.register !== 'function') {
    return { ok: false, reason: '宿主未提供 agentPresets.register 面（老版本线）' }
  }
  try {
    const raw = await Promise.resolve(agentPresets.register(imPresetDefinition()))
    const dispose = typeof raw === 'function' ? (raw as () => Promise<void> | void) : undefined
    return { ok: true, dispose }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/duplicate/i.test(message)) {
      // 热重载撞名：定义已在册，可直接用作默认预设。
      return { ok: true, reason: 'already registered' }
    }
    return { ok: false, reason: message }
  }
}
