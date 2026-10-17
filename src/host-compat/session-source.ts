/**
 * 跨版本窄腰·会话消息署名（source kind）。
 *
 * 断裂面：宿主 ≥0.1.7-rc.1 的 Session v4 要求生产者自有署名 kind
 * `plugin:<name>`，写旧形制（裸 kind:'plugin' + plugin 字段）会触发
 * SessionFormatError 整轮失败；老线反过来——写 `plugin:<name>` 可能不被识别。
 * 判定用设置面代际作代理（gen3 ⇔ ≥0.1.7 线，两断裂面由同一次宿主换代引入），
 * 该代理关系须在逐线矩阵中坐实（checklist B7），矩阵红一格即改探测面。
 */
import type { UnionCapabilities } from './services.js'

export const PLUGIN_NAME = 'dsh-im-union'

export interface MessageSource {
  kind: string
  plugin?: string
}

/** 注入会话的引导/引用/来源信息应携带的署名对象。 */
export function messageSourceFor(caps: UnionCapabilities): MessageSource {
  if (caps.settingsGeneration === 'gen3') {
    return { kind: `plugin:${PLUGIN_NAME}` }
  }
  return { kind: 'plugin', plugin: PLUGIN_NAME }
}

/**
 * 渠道 id → 会话列表角标（T3.6 渠道 Logo 前缀）。
 * id 集与 `src/channels/*.ts` 的 `adapter.id` 对齐（净室自定缩写，
 * 双语源 = 渠道中文名 / 官方英文名）；`wecom` 与 `wecom-app` 同属企微一族，
 * 共角标 WC（列表区分靠会话本身）。
 */
const CHANNEL_BADGES: Record<string, string> = {
  telegram: 'TG', //  Telegram
  weixin: 'WX', //  微信 / WeChat（iLink 个人号）
  feishu: 'FS', //  飞书 / Feishu (Lark)
  discord: 'DC', //  Discord
  wecom: 'WC', //  企业微信 / WeCom
  'wecom-app': 'WC', //  企业微信应用 / WeCom self-built app
  dingtalk: 'Ding', //  钉钉 / DingTalk
  qq: 'QQ', //  QQ
  slack: 'SL', //  Slack
  whatsapp: 'WA', //  WhatsApp
  imessage: 'IM', //  iMessage
  matrix: 'MX', //  Matrix
}

/** 未知渠道不伪装成已知角标：回退为 id 前 3 字母大写；空 id 回空串（标题不带方括号）。 */
export function channelBadge(channel: string): string {
  const id = typeof channel === 'string' ? channel.trim().toLowerCase() : ''
  if (id === '') return ''
  const known = CHANNEL_BADGES[id]
  if (known !== undefined) return known
  return Array.from(id).slice(0, 3).join('').toUpperCase()
}

/** 会话标题正文上限（码点）：宿主列表行宽有限，取首条消息前 30 字。 */
export const SESSION_TITLE_BODY_MAX = 30

/**
 * 会话标题：`[角标] 首条正文前 30 字`（无正文时只留 `[角标]`，无角标时只留正文）。
 * 折叠换行/连续空白，保证单行；按码点截断，不劈碎代理对。
 */
export function sessionTitle(channel: string, firstText: string): string {
  const badge = channelBadge(channel)
  const body = Array.from(
    (typeof firstText === 'string' ? firstText : '').replace(/\s+/g, ' ').trim(),
  ).slice(0, SESSION_TITLE_BODY_MAX).join('')
  if (badge === '') return body
  if (body === '') return `[${badge}]`
  return `[${badge}] ${body}`
}
