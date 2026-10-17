/**
 * 渠道元数据（声明式驱动设置表单——meta.fields 决定设置页要收集什么，
 * client 半不含任何渠道硬编码）。secret:true 的字段只单向提交宿主凭据库。
 */

export type BindMode = 'qr' | 'credentials' | 'qr-or-credentials'

export interface ChannelField {
  key: string
  label: { zh: string; en: string }
  secret: boolean
  required: boolean
  helpUrl?: string
}

export interface ChannelMeta {
  id: string
  label: { zh: string; en: string }
  bind: BindMode
  fields: ChannelField[]
  /** 该平台是否需要本机条件（iMessage=macOS 等）——设置页据此灰显。 */
  hostRequirement?: 'macos' | 'ffmpeg' | 'none'
}

const cred = (key: string, zh: string, en: string, helpUrl?: string): ChannelField => ({
  key,
  label: { zh, en },
  secret: true,
  required: true,
  helpUrl,
})
const plain = (key: string, zh: string, en: string): ChannelField => ({
  key,
  label: { zh, en },
  secret: false,
  required: false,
})

/** P0 五渠道 + P1 三渠道的声明；P2 渠道随实现追加。 */
export const CHANNEL_META: Record<string, ChannelMeta> = {
  feishu: {
    id: 'feishu',
    label: { zh: '飞书', en: 'Feishu / Lark' },
    bind: 'qr-or-credentials',
    fields: [cred('appId', 'App ID', 'App ID'), cred('appSecret', 'App Secret', 'App Secret')],
  },
  weixin: {
    id: 'weixin',
    label: { zh: '微信', en: 'WeChat (iLink)' },
    bind: 'qr',
    fields: [plain('accountNote', '账号备注', 'Account note')],
  },
  telegram: {
    id: 'telegram',
    label: { zh: 'Telegram', en: 'Telegram' },
    bind: 'credentials',
    fields: [cred('botToken', 'Bot Token（@BotFather）', 'Bot Token (from @BotFather)')],
  },
  discord: {
    id: 'discord',
    label: { zh: 'Discord', en: 'Discord' },
    bind: 'credentials',
    fields: [cred('botToken', 'Bot Token（Developer Portal，需 Message Content Intent）', 'Bot Token (Message Content Intent required)')],
  },
  wecom: {
    id: 'wecom',
    label: { zh: '企业微信', en: 'WeCom' },
    bind: 'qr-or-credentials',
    fields: [cred('botId', 'Bot ID', 'Bot ID'), cred('secret', 'Secret', 'Secret')],
  },
  dingtalk: {
    id: 'dingtalk',
    label: { zh: '钉钉', en: 'DingTalk' },
    bind: 'qr-or-credentials',
    fields: [cred('clientId', 'Client ID', 'Client ID'), cred('clientSecret', 'Client Secret', 'Client Secret')],
  },
  qq: {
    id: 'qq',
    label: { zh: 'QQ', en: 'QQ' },
    bind: 'qr-or-credentials',
    fields: [cred('appId', 'AppID', 'AppID'), cred('appSecret', 'AppSecret', 'AppSecret')],
  },
  slack: {
    id: 'slack',
    label: { zh: 'Slack', en: 'Slack' },
    bind: 'credentials',
    fields: [cred('botToken', 'Bot Token（xoxb-）', 'Bot Token (xoxb-)'), cred('appToken', 'App Token（xapp-，需 Socket Mode）', 'App Token (xapp-, Socket Mode)')],
  },
}

export function channelIds(): string[] {
  return Object.keys(CHANNEL_META)
}
