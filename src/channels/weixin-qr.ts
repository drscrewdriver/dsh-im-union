/**
 * 微信 iLink 扫码登录（账号绑定面，T1.2 的 bind:'qr' 实现）。
 *
 * 协议事实（官方协议文档「二维码登录」节）：
 * - POST /ilink/bot/get_bot_qrcode?bot_type=3（不带 Authorization，带
 *   AuthorizationType/X-WECHAT-UIN/JSON 头）body {local_token_list: []}
 *   → {qrcode, qrcode_img_content}（qrcode 供程序轮询，img_content 是
 *   要编码进二维码图的 URL——两者别混用）；
 * - GET /ilink/bot/get_qrcode_status?qrcode=…（长轮询 hold ≤35s，无鉴权头，
 *   只带应用头）→ status 状态机：wait/scaned/confirmed/expired/
 *   need_verifycode/verify_code_blocked/scaned_but_redirect/binded_redirect；
 * - confirmed → {bot_token, ilink_bot_id, baseurl, ilink_user_id}；bot_token
 *   单向写 vault（红线 D4：管理端点回包零 bot_token 值，只报完成态）。
 *
 * QR 渲染：qrcode_img_content 交给 qrcode 包生成 PNG data URL（懒 import，
 * 只有走扫码才拉包）。verify_code 场景由调用方回传（管理端点透传参数）。
 */
import { randomBytes } from 'node:crypto'
import type { FetchLike } from './weixin.js'

export interface QrStartResult {
  qrcode: string
  qrDataUrl: string
}

export type QrStatusResult =
  | { status: 'wait' | 'scaned' | 'expired' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect' | 'scaned_but_redirect' }
  | { status: 'confirmed'; account: { botId: string; baseUrl: string; ilinkUserId: string; botToken: string } }

const API_BASE = 'https://ilinkai.weixin.qq.com'
const APP_HEADERS = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132100' }

function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

export class WeixinQrLogin {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** 取码并渲染成 PNG data URL（给设置页展示）。 */
  async start(): Promise<QrStartResult> {
    const response = await this.fetchImpl(`${API_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
        ...APP_HEADERS,
      },
      body: JSON.stringify({ local_token_list: [] }),
    })
    if (!response.ok) throw new Error(`微信扫码取码失败：HTTP ${response.status}`)
    const json = (await response.json()) as Record<string, any>
    const qrcode = String(json.qrcode ?? '')
    const content = String(json.qrcode_img_content ?? '')
    if (qrcode === '' || content === '') throw new Error('微信扫码取码失败：响应缺少 qrcode 字段')
    const { default: QRCode } = await import('qrcode')
    const qrDataUrl = await QRCode.toDataURL(content, { margin: 1, width: 280 })
    return { qrcode, qrDataUrl }
  }

  /** 轮询一次状态（服务端 hold 最长 ~35s；调用方在 confirmed 前循环）。 */
  async pollStatus(qrcode: string, verifyCode?: string): Promise<QrStatusResult> {
    const qs = new URLSearchParams({ qrcode })
    if (verifyCode !== undefined && verifyCode !== '') qs.set('verify_code', verifyCode)
    const response = await this.fetchImpl(`${API_BASE}/ilink/bot/get_qrcode_status?${qs.toString()}`, {
      method: 'GET',
      headers: APP_HEADERS,
    })
    if (!response.ok) return { status: 'wait' } // 官方客户端把请求失败折算成 wait
    const json = (await response.json()) as Record<string, any>
    const status = String(json.status ?? 'wait')
    if (status === 'confirmed') {
      const botToken = typeof json.bot_token === 'string' ? json.bot_token : ''
      if (botToken === '') return { status: 'wait' }
      // bot_token 随结果返回但由管理端点单向写 vault，回包零值透露（D4）。
      return {
        status: 'confirmed',
        account: {
          botId: String(json.ilink_bot_id ?? ''),
          baseUrl: String(json.baseurl ?? API_BASE),
          ilinkUserId: String(json.ilink_user_id ?? ''),
          botToken,
        },
      }
    }
    const known = ['wait', 'scaned', 'expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect', 'scaned_but_redirect'] as const
    if ((known as readonly string[]).includes(status)) return { status: status as (typeof known)[number] }
    this.log(`weixin-qr: 未知状态 ${status}，按 wait 处理`)
    return { status: 'wait' }
  }
}
