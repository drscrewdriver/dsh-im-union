// T1.2 扫码绑定面：QR 状态机折算与 bot_token 透传（fetch 注入，零网络）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { WeixinQrLogin } from '../lib/channels/weixin-qr.js'

const resp = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

function fetchStub(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { impl, calls }
}

test('start：取码并渲染 PNG data URL（qrcode 本地生成）', async () => {
  const { impl, calls } = fetchStub(() => resp(200, { qrcode: 'QR1', qrcode_img_content: 'https://login.wechatpass.com/x?abc' }))
  const qr = new WeixinQrLogin(impl)
  const out = await qr.start()
  assert.equal(out.qrcode, 'QR1')
  assert.match(out.qrDataUrl, /^data:image\/png;base64,/, '回包必须是可直接展示的 PNG data URL')
  const [, qs] = calls[0].url.split('?')
  assert.match(qs, /bot_type=3/)
  assert.ok(calls[0].init.headers['X-WECHAT-UIN'], '取码也要防重放头（协议口径）')
})

test('pollStatus：confirmed 透传 botToken；HTTP 失败折算 wait；未知状态折算 wait', async () => {
  const { impl } = fetchStub((url) => {
    if (url.includes('qrcode=OK1')) return resp(200, { status: 'confirmed', bot_token: 'BT@im.bot:9', ilink_bot_id: 'b1', baseurl: 'https://ilinkai.weixin.qq.com', ilink_user_id: 'u1@im.wechat' })
    if (url.includes('qrcode=BAD')) return resp(500, {})
    if (url.includes('qrcode=WEIRD')) return resp(200, { status: 'some_future_state' })
    return resp(200, { status: 'scaned' })
  })
  const qr = new WeixinQrLogin(impl)
  const ok = await qr.pollStatus('OK1')
  assert.equal(ok.status, 'confirmed')
  assert.equal(ok.account.botToken, 'BT@im.bot:9')
  assert.equal(ok.account.ilinkUserId, 'u1@im.wechat')
  assert.deepEqual(await qr.pollStatus('BAD'), { status: 'wait' })
  assert.deepEqual(await qr.pollStatus('WEIRD'), { status: 'wait' })
  assert.deepEqual(await qr.pollStatus('S1'), { status: 'scaned' })
})

test('pollStatus：confirmed 但缺 bot_token 视同 wait（不产出半成品凭证）', async () => {
  const { impl } = fetchStub(() => resp(200, { status: 'confirmed' }))
  const qr = new WeixinQrLogin(impl)
  assert.deepEqual(await qr.pollStatus('X'), { status: 'wait' })
})
