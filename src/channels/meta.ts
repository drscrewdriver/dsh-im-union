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
      plain('encryption', 'E2EE 模式 optional/required（首版解密面未接）', 'E2EE mode (decrypt not wired)'),
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
}

export function channelIds(): string[] {
  return Object.keys(CHANNEL_META)
}
