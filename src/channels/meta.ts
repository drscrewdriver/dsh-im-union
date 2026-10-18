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
  /** 纯出站通知类：无入站/路由语义，设置页隐藏账号 ID（自动生成内部键）。 */
  notifyOnly?: boolean
  /** 账号 ID 自动生成（用户无需手填）：notifyOnly 蕴含此位；双向渠道若天然标识
   * （如 email 的邮箱地址）也应置 true。 */
  autoAccountId?: boolean
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
    fields: [
      cred('appId', 'App ID', 'App ID'),
      cred('appSecret', 'App Secret', 'App Secret'),
      // 语音档位（T3.5）：密钥只入凭据库；必填=false——不开语音时留空即可。
      { key: 'dashScopeKey', label: { zh: 'DashScope API Key（语音转写/合成，可选）', en: 'DashScope API Key (voice ASR/TTS, optional)' }, secret: true, required: false },
      plain('voiceEnabled', '语音档位（填 true 开启，需本机 ffmpeg；缺位时只降级不谎报）', 'Voice tier ("true" to enable; needs local ffmpeg, degrades otherwise)'),
      plain('dashscopeModel', 'ASR 模型（缺省 qwen3-asr-flash）', 'ASR model (default qwen3-asr-flash)'),
      plain('dashscopeTtsModel', 'TTS 模型（缺省 cosyvoice-v3-flash）', 'TTS model (default cosyvoice-v3-flash)'),
      plain('dashscopeVoice', 'TTS 音色（缺省 longanyang）', 'TTS voice (default longanyang)'),
    ],
  },
  weixin: {
    id: 'weixin',
    label: { zh: '微信', en: 'WeChat (iLink)' },
    bind: 'qr',
    fields: [
      // botToken 由扫码授权流程自动写入（advanced 粘贴亦可），非用户必填。
      { key: 'botToken', label: { zh: 'Bot Token（扫码自动获取）', en: 'Bot Token (auto via QR login)' }, secret: true, required: false },
      plain('accountNote', '账号备注', 'Account note'),
    ],
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
  whatsapp: {
    id: 'whatsapp',
    label: { zh: 'WhatsApp', en: 'WhatsApp' },
    bind: 'qr',
    // 配对型渠道：creds 落 auth 目录（config.authDir），无手工 secret 字段；重配同目录即恢复。
    fields: [plain('authDir', '凭据目录（缺省账号子目录）', 'Auth dir (defaults per account)'), plain('accountNote', '账号备注', 'Account note')],
    hostRequirement: 'none',
  },
  matrix: {
    id: 'matrix',
    label: { zh: 'Matrix', en: 'Matrix' },
    bind: 'credentials',
    fields: [
      cred('accessToken', 'Access Token', 'Access Token'),
      { key: 'homeserverBaseUrl', label: { zh: ' homeserver 地址', en: 'Homeserver base URL' }, secret: false, required: true },
      plain('encryption', 'E2EE 模式 disabled/optional/required（A 档：入站 Megolm 解密，出站明文）', 'E2EE mode disabled/optional/required (tier A: inbound Megolm decrypt, plaintext outbound)'),
      plain('dmRoomList', '私聊房间表（逗号分隔）', 'DM room list (comma separated)'),
    ],
  },
  imessage: {
    id: 'imessage',
    label: { zh: 'iMessage', en: 'iMessage' },
    bind: 'credentials',
    // 本机条件渠道：非 macOS 装载侧明确拒载（构造期抛）。
    fields: [plain('selfHandle', '本机 Apple ID/手机号', 'Self handle'), plain('chatDbPath', 'chat.db 路径（缺省标准位置）', 'chat.db path (optional)')],
    hostRequirement: 'macos',
  },
  'wecom-app': {
    id: 'wecom-app',
    label: { zh: '企业微信（自建应用）', en: 'WeCom (self-built app)' },
    bind: 'credentials',
    fields: [
      cred('corpId', '企业 ID (CorpID)', 'Corp ID'),
      cred('corpSecret', '应用 Secret', 'App Secret'),
      cred('encodingAesKey', '回调 EncodingAESKey', 'Callback EncodingAESKey'),
      cred('callbackToken', '回调 Token', 'Callback Token'),
      { key: 'agentId', label: { zh: '应用 AgentId', en: 'App AgentId' }, secret: false, required: true },
    ],
  },
  email: {
    id: 'email',
    label: { zh: 'Email（IMAP/SMTP）', en: 'Email (IMAP/SMTP)' },
    bind: 'credentials',
    // 邮箱地址即天然账号标识，内部键自动生成。
    autoAccountId: true,
    fields: [
      { key: 'address', label: { zh: '邮箱地址', en: 'Email address' }, secret: false, required: true },
      { key: 'imapHost', label: { zh: 'IMAP 主机', en: 'IMAP host' }, secret: false, required: true },
      { key: 'smtpHost', label: { zh: 'SMTP 主机', en: 'SMTP host' }, secret: false, required: true },
      plain('imapPort', 'IMAP 端口（默认 993）', 'IMAP port (default 993)'),
      plain('smtpPort', 'SMTP 端口（默认 465）', 'SMTP port (default 465)'),
      cred('password', '邮箱密码/应用专用密码', 'Mailbox password / app-specific password'),
      plain('pollIntervalSec', '拉询间隔秒（默认 60）', 'Poll interval seconds (default 60)'),
    ],
  },
  'dingtalk-notify': {
    id: 'dingtalk-notify',
    label: { zh: '钉钉通知（群机器人）', en: 'DingTalk notify (group webhook)' },
    bind: 'credentials',
    notifyOnly: true,
    // 纯出站通知类：群设置直加自定义机器人，不建应用；安全三档按官方口径。
    fields: [
      cred('webhook', 'Webhook 地址或 access_token', 'Webhook URL or access_token'),
      cred('signSecret', '加签密钥（security=sign 时必填）', 'Signing secret (when security=sign)'),
      plain('security', '安全档 keyword/sign/none', 'Security mode keyword/sign/none'),
      plain('keyword', '关键词模板（keyword 档未命中时自动补前缀）', 'Keyword template (auto-prefixed when missing)'),
      plain('atAll', '是否 @所有人（true）', 'Mention all (true)'),
    ],
  },
  'qq-notify': {
    id: 'qq-notify',
    label: { zh: 'QQ 通知（主动推送）', en: 'QQ notify (active push)' },
    bind: 'credentials',
    notifyOnly: true,
    // 官方主动消息面（bot.qq.com 查实）：受频控与用户「允许主动发送」开关约束。
    fields: [
      { key: 'appId', label: { zh: '机器人 AppID', en: 'Bot AppID' }, secret: false, required: true },
      cred('clientSecret', '机器人 AppSecret', 'Bot AppSecret'),
    ],
  },
}

export function channelIds(): string[] {
  return Object.keys(CHANNEL_META)
}
