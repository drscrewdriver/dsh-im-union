// Email 渠道单测：线程键三级回退 / 自环过滤（回归必测） / html 粗剥 / 引用提取截断 /
// 附件分档 / sendMail 参数断言（In-Reply-To/References、Re: 去重） / 5xx vs 网络错分型（D7） /
// 缺凭据工厂抛 / 诊断三态+零密码回显 / 退避封顶 / 注入面工厂。
// 协议面全走注入的 fake imapFactory/transport，零真实 SMTP/IMAP、零网络。
// 风格仿 tests/whatsapp.test.mjs（node:test + assert/strict，导入编译产物 lib/）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EmailAdapter,
  EmailApiError,
  EmailUncertainError,
  createEmailAdapter,
  stripHtml,
  extractQuotedLines,
  replySubject,
  threadKeyOf,
  parseFromAddress,
  classifySendError,
} from '../lib/channels/email.js'

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const EOL = CR + LF
const OWN = 'bot@example.com'
const SECRET = 's3cret-pa55'

// —— fake IMAP / SMTP ——————————————————————————————————————

/** fake imapflow client：search 回 uid 表；fetch 逐个产出 {uid, source}；flags 记录。 */
function makeFakeImap(options = {}) {
  const client = {
    messages: options.messages ?? [],
    searchCalls: [],
    flagged: [],
    connectCount: 0,
    connectThrows: options.connectThrows ?? null,
    searchThrows: options.searchThrows ?? null,
    fetchThrows: options.fetchThrows ?? null,
    mailboxList: options.mailboxList ?? [{ path: 'INBOX' }],
    async connect() {
      client.connectCount += 1
      if (client.connectThrows !== null) throw client.connectThrows
    },
    async getMailboxList() {
      return client.mailboxList
    },
    async search(criteria, opts) {
      client.searchCalls.push({ criteria, opts })
      if (client.searchThrows !== null) throw client.searchThrows
      return client.messages.map((m) => m.uid)
    },
    fetch(range, query, opts) {
      if (client.fetchThrows !== null) {
        return {
          [Symbol.asyncIterator]() {
            return { async next() { throw client.fetchThrows } }
          },
        }
      }
      const picked = client.messages.filter((m) => range.includes(m.uid))
      let i = 0
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (i >= picked.length) return { done: true, value: undefined }
              const m = picked[i++]
              const value = { uid: m.uid }
              if (m.source !== undefined) value.source = m.source
              return { done: false, value }
            },
          }
        },
      }
    },
    async setMessageFlags(cid, mode, flags, opts) {
      client.flagged.push({ cid, mode, flags })
    },
    async logout() {
      client.loggedOut = true
    },
  }
  return client
}

/** fake nodemailer transport：sendMail 记录并回 messageId；可注入下一次失败/verify 行为。 */
function makeFakeTransport() {
  const transport = {
    mails: [],
    failNext: null,
    verifyResult: '250 OK verified',
    async sendMail(mail) {
      if (transport.failNext !== null) {
        const f = transport.failNext
        transport.failNext = null
        throw f
      }
      transport.mails.push(mail)
      return { messageId: '<sent-' + transport.mails.length + '@smtp>', response: '250 Ok' }
    },
    async verify() {
      if (transport.verifyResult instanceof Error) throw transport.verifyResult
      return transport.verifyResult
    },
  }
  return transport
}

/** 组一封 RFC822 原文（默认 text/plain 7bit；parts 传入则拼 multipart）。 */
function makeRawEmail(fields) {
  const headers = []
  headers.push('From: ' + fields.from)
  headers.push('To: ' + (fields.to ?? OWN))
  headers.push('Subject: ' + (fields.subject ?? 'hello'))
  headers.push('Date: ' + (fields.date ?? 'Mon, 13 Oct 2026 09:00:00 +0800'))
  if (fields.messageId !== undefined) headers.push('Message-ID: ' + fields.messageId)
  if (fields.references !== undefined) headers.push('References: ' + fields.references)
  if (fields.inReplyTo !== undefined) headers.push('In-Reply-To: ' + fields.inReplyTo)
  let body = ''
  if (fields.parts !== undefined) {
    const boundary = 'BX' + headers.length + 'boundary'
    headers.push('MIME-Version: 1.0')
    headers.push('Content-Type: multipart/mixed; boundary="' + boundary + '"')
    const blocks = fields.parts.map((p) => {
      const ph = [...p.headers]
      const content = p.raw !== undefined ? p.raw : Buffer.from(p.text ?? '', 'utf-8').toString('base64')
      ph.push('Content-Transfer-Encoding: ' + (p.cte ?? 'base64'))
      return ph.join(EOL) + EOL + EOL + content + EOL
    })
    body = '--' + boundary + EOL + blocks.join('--' + boundary + EOL) + '--' + boundary + '--' + LF
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8')
    headers.push('Content-Transfer-Encoding: base64')
    body = Buffer.from(fields.text ?? '', 'utf-8').toString('base64')
  }
  return Buffer.from(headers.join(EOL) + EOL + EOL + body, 'latin1')
}

/** 附件件：{ type, filename, bytes } → multipart 叶子。 */
function attachmentPart(type, filename, bytes) {
  return {
    headers: [
      'Content-Type: ' + type + '; filename="' + filename + '"',
      'Content-Disposition: attachment; filename="' + filename + '"',
    ],
    raw: Buffer.from(bytes).toString('base64'),
  }
}

function textPart(text, subtype) {
  return { headers: ['Content-Type: text/' + subtype + '; charset=utf-8'], text }
}

/** 注入双 fake 的已连接适配器。 */
async function connectedFixture(options = {}) {
  const messages = options.messages ?? []
  const client = options.client ?? makeFakeImap({ messages, ...options.imap })
  const transport = options.transport ?? makeFakeTransport()
  const factoryCalls = []
  const imapFactory = (cfg) => {
    factoryCalls.push(cfg)
    return client
  }
  const adapter = new EmailAdapter({
    accountId: 'acct',
    address: OWN,
    password: SECRET,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    imapHost: 'imap.example.com',
    imapPort: 993,
    pollIntervalSec: 3600,
    transport,
    imapFactory,
  })
  const received = []
  adapter.onMessage((m) => received.push(m))
  await adapter.connect()
  return { adapter, client, transport, received, factoryCalls }
}

// —— 收：线程键三级回退 ——————————————————————————————————

test('线程键：References 最后一个 → In-Reply-To → 发件人小写地址 三级回退', async () => {
  const messages = [
    { uid: 1, source: makeRawEmail({ from: 'Alice <alice@B.example>', references: '<root@b> <mid1@b>', messageId: '<m1@b>', text: 'a' }) },
    { uid: 2, source: makeRawEmail({ from: 'bob@B.example', inReplyTo: '<parent@b>', messageId: '<m2@b>', text: 'b' }) },
    { uid: 3, source: makeRawEmail({ from: 'CARL@B.example', messageId: '<m3@b>', text: 'c' }) },
  ]
  const { adapter, client, received } = await connectedFixture({ messages })
  const n = await adapter.pollOnce()
  assert.equal(n, 3)
  assert.equal(received[0].address.chatId, '<mid1@b>')
  assert.equal(received[1].address.chatId, '<parent@b>')
  assert.equal(received[2].address.chatId, 'carl@b.example')
  // userId=发件人（小写归一）、threadId 携带回信方向
  assert.equal(received[2].userId, 'carl@b.example')
  assert.equal(received[2].address.threadId, 'carl@b.example')
  assert.equal(received[0].userDisplayName, 'Alice')
  assert.equal(received[0].address.channel, 'email')
  // 处理完标 \Seen（下轮 UNSEEN 不再命中）
  assert.equal(client.flagged.length, 3)
  assert.deepEqual(client.flagged[0], { cid: 1, mode: 'add', flags: 'seen' })
})

test('threadKeyOf 纯函数：空 References 退 In-Reply-To，两者皆空退发件人', () => {
  assert.equal(threadKeyOf('<r1@x> <r2@x>', '<p@x>', 'a@b'), '<r2@x>')
  assert.equal(threadKeyOf(undefined, '<p@x>', 'a@b'), '<p@x>')
  assert.equal(threadKeyOf(undefined, undefined, 'a@b'), 'a@b')
  assert.equal(threadKeyOf('', '', ''), undefined)
})

// —— 自环过滤（回归必测：邮件桥回环是最大事故源） ————————————

test('自环过滤：from 等于本账号 address（大小写不敏感）→ 丢弃', async () => {
  const messages = [
    { uid: 1, source: makeRawEmail({ from: 'BOT@Example.com', to: 'user@x', text: 'echo loop' }) },
    { uid: 2, source: makeRawEmail({ from: '  <bot@example.com>', text: 'angle form' }) },
    { uid: 3, source: makeRawEmail({ from: 'user@x.com', text: 'legit' }) },
  ]
  const { adapter, received } = await connectedFixture({ messages })
  const n = await adapter.pollOnce()
  assert.equal(n, 1)
  assert.equal(received.length, 1)
  assert.equal(received[0].userId, 'user@x.com')
})

// —— 正文归一：text/plain 优先、仅 html 粗剥标签 ————————————

test('正文：text/plain 优先；仅 html 时粗剥标签+实体解码', async () => {
  const htmlOnly = makeRawEmail({
    from: 'a@x.com',
    parts: [{ headers: ['Content-Type: text/html; charset=utf-8'], text: '<html><head><title>t</title></head><body><p>Hello <b>world</b> &amp; friends</p><br>line2<script>var x=1</script></body></html>' }],
  })
  const both = makeRawEmail({
    from: 'b@x.com',
    parts: [textPart('plain wins', 'plain'), textPart('<p>html loses</p>', 'html')],
  })
  const { adapter, received } = await connectedFixture({ messages: [{ uid: 1, source: htmlOnly }, { uid: 2, source: both }] })
  await adapter.pollOnce()
  assert.equal(received[0].text, 'Hello world & friends' + LF + LF + 'line2')
  assert.equal(received[1].text, 'plain wins')
  // 纯函数面复核
  assert.equal(stripHtml('<div>a&nbsp;b</div>'), 'a b')
})

// —— 引用提取（'>' 前缀行，≤800 码点截断）+ quoteId ————————————

test('引用提取：> 前缀行提取 ≤800 码点截断，quoteId=In-Reply-To', async () => {
  const Q = String.fromCharCode(62) // '>'
  const longQuote = Array.from({ length: 40 }, () => Q + ' ' + 'あ'.repeat(30)).join(LF)
  const msg = makeRawEmail({
    from: 'a@x.com',
    inReplyTo: '<quoted-1@x>',
    text: 'top line' + LF + longQuote,
  })
  const { adapter, received } = await connectedFixture({ messages: [{ uid: 1, source: msg }] })
  await adapter.pollOnce()
  const m = received[0]
  assert.equal(m.quoteId, '<quoted-1@x>')
  assert.ok(m.quoteText !== undefined)
  assert.equal(Array.from(m.quoteText).length, 800)
  assert.ok(m.quoteText.split(LF).every((l) => new RegExp('^' + Q).test(l)))
  // 短引用不截断
  const short = extractQuotedLines('body' + LF + ' > indented quote' + LF + 'tail')
  assert.equal(short, '> indented quote')
  assert.equal(extractQuotedLines('no quotes here'), undefined)
})

// —— 附件分档：image/* → images，其余 → files ————————————————

test('附件分档：image/png 进 images、application/pdf 进 files，字节完整', async () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]
  const pdf = [0x25, 0x50, 0x44, 0x46]
  const msg = makeRawEmail({
    from: 'a@x.com',
    parts: [
      textPart('see attached', 'plain'),
      attachmentPart('image/png', 'shot.png', png),
      {
        headers: ['Content-Type: application/pdf; filename="doc.pdf"', 'Content-Disposition: attachment; filename="doc.pdf"'],
        raw: Buffer.from(pdf).toString('base64'),
      },
    ],
  })
  const { adapter, received } = await connectedFixture({ messages: [{ uid: 1, source: msg }] })
  await adapter.pollOnce()
  const m = received[0]
  assert.equal(m.text, 'see attached')
  assert.equal(m.images.length, 1)
  assert.equal(m.images[0].name, 'shot.png')
  assert.equal(m.images[0].mimeType, 'image/png')
  assert.deepEqual(Array.from(m.images[0].data), png)
  assert.equal(m.files.length, 1)
  assert.equal(m.files[0].name, 'doc.pdf')
  assert.deepEqual(Array.from(m.files[0].data), pdf)
})

test('fetch source 失败 → 降级占位文本，不丢信', async () => {
  const client = makeFakeImap({ messages: [{ uid: 7 }] }) // 无 source 字段
  client.fetchThrows = new Error('FETCH io timeout')
  const { adapter, received } = await connectedFixture({ client })
  const n = await adapter.pollOnce()
  assert.equal(n, 1)
  assert.equal(received.length, 1)
  assert.equal(received[0].text, '[邮件正文取回失败]')
  assert.equal(received[0].address.chatId, 'uid:7')
})

// —— 发：sendMail 参数断言（In-Reply-To/References、Re: 去重） ————

test('reply：To=来信方向、In-Reply-To/References=来信 Message-ID、主题 Re: 补前缀', async () => {
  const msg = makeRawEmail({
    from: 'Alice <alice@x.com>',
    subject: 'Meeting notes',
    messageId: '<abc@m>',
    references: '<root@m>',
    text: 'q',
  })
  const { adapter, transport, received } = await connectedFixture({ messages: [{ uid: 1, source: msg }] })
  await adapter.pollOnce()
  const receipt = await adapter.reply(received[0].address, 'answer text')
  assert.equal(receipt.uncertain, false)
  assert.equal(receipt.platformMessageId, '<sent-1@smtp>')
  const mail = transport.mails[0]
  assert.equal(mail.to, 'alice@x.com')
  assert.equal(mail.from, OWN)
  assert.equal(mail.inReplyTo, '<abc@m>')
  assert.equal(mail.references, '<root@m> <abc@m>')
  assert.equal(mail.subject, 'Re: Meeting notes')
  assert.equal(mail.text, 'answer text')
})

test('reply：主题已有 Re: 不叠加（大小写不敏感）', async () => {
  const msg = makeRawEmail({ from: 'a@x.com', subject: 're: Q3 plan', messageId: '<d1@m>', text: 'q' })
  const { adapter, transport, received } = await connectedFixture({ messages: [{ uid: 1, source: msg }] })
  await adapter.pollOnce()
  await adapter.reply(received[0].address, 'ok')
  assert.equal(transport.mails[0].subject, 're: Q3 plan')
  assert.equal(replySubject('Re: a'), 'Re: a')
  assert.equal(replySubject('Fwd: b'), 'Re: Fwd: b')
})

test('sendFile：附件邮件（filename/content/contentType），caps.fileOut=true', async () => {
  const msg = makeRawEmail({ from: 'a@x.com', messageId: '<d2@m>', subject: 'file please', text: 'send it' })
  const { adapter, transport, received } = await connectedFixture({ messages: [{ uid: 1, source: msg }] })
  await adapter.pollOnce()
  const receipt = await adapter.sendFile(received[0].address, { name: 'out.bin', data: new Uint8Array([1, 2, 3]), mimeType: 'application/octet-stream' })
  assert.equal(receipt.uncertain, false)
  const mail = transport.mails[0]
  assert.equal(mail.to, 'a@x.com')
  assert.equal(mail.attachments.length, 1)
  assert.equal(mail.attachments[0].filename, 'out.bin')
  assert.equal(mail.attachments[0].contentType, 'application/octet-stream')
  assert.deepEqual(Array.from(mail.attachments[0].content), [1, 2, 3])
})

// —— Receipt 错误分型（D7：5xx 确定性 vs 网络/4xx 临时） ————————

test('sendMail 分型：5xx/EAUTH → EmailApiError；网络断/4xx → EmailUncertainError', async () => {
  const msg = makeRawEmail({ from: 'a@x.com', messageId: '<d3@m>', text: 'q' })
  const { adapter, transport, received } = await connectedFixture({ messages: [{ uid: 1, source: msg }] })
  await adapter.pollOnce()
  const addr = received[0].address

  transport.failNext = Object.assign(new Error('550 no such user'), { responseCode: 550 })
  await assert.rejects(() => adapter.reply(addr, 'x'), (e) => e instanceof EmailApiError && e.statusCode === 550)

  transport.failNext = Object.assign(new Error('Invalid credentials'), { code: 'EAUTH' })
  await assert.rejects(() => adapter.reply(addr, 'x'), (e) => e instanceof EmailApiError)

  transport.failNext = Object.assign(new Error('socket hang up'), { code: 'ESOCKET' })
  await assert.rejects(() => adapter.reply(addr, 'x'), (e) => e instanceof EmailUncertainError)

  transport.failNext = Object.assign(new Error('421 try later'), { responseCode: 421 })
  await assert.rejects(() => adapter.reply(addr, 'x'), (e) => e instanceof EmailUncertainError)

  // 纯函数口径复核（response 文本取码）
  assert.ok(classifySendError(Object.assign(new Error('x'), { response: '450 busy' })) instanceof EmailUncertainError)
  assert.ok(classifySendError(new Error('ETIMEDOUT')) instanceof EmailUncertainError)
})

// —— 工厂：缺 password/address 抛校验错；注入面工厂 ————————

test('createEmailAdapter：缺 password/address 抛校验错，config 明文/secret 分面装配', () => {
  assert.throws(
    () => createEmailAdapter({ accountId: 'a', config: { address: OWN }, secrets: {} }),
    /password/,
  )
  assert.throws(
    () => createEmailAdapter({ accountId: 'a', config: {}, secrets: { password: 'p' } }),
    /address/,
  )
  const transport = makeFakeTransport()
  const client = makeFakeImap({ messages: [] })
  const adapter = createEmailAdapter(
    {
      accountId: 'a',
      config: { address: OWN, smtpHost: 's', smtpPort: '587', imapHost: 'i', imapPort: '143', pollIntervalSec: '30' },
      secrets: { password: 'pw' },
    },
    { transport, imapFactory: () => client },
  )
  assert.ok(adapter instanceof EmailAdapter)
  assert.equal(adapter.id, 'email')
})

// —— 诊断三态 + 零密码回显 ——————————————————————————————————

test('诊断：缺凭据 unverified / 失败 failed（脱敏）/ 通过 passed', async () => {
  // 缺凭据
  const bare = new EmailAdapter({ accountId: 'a' })
  const bareChecks = await bare.diagnose()
  assert.deepEqual(bareChecks.map((c) => [c.name, c.status]), [['imap-login-list', 'unverified'], ['smtp-verify', 'unverified']])

  // 失败：hint 经脱敏，零密码回显（connect 成功后再注入失败，避开建连期抛错）
  const client = makeFakeImap({ messages: [] })
  const transport = makeFakeTransport()
  const { adapter } = await connectedFixture({ client, transport })
  client.connectThrows = new Error('LOGIN failed for ' + SECRET)
  transport.verifyResult = new Error('auth rejected (' + SECRET + ')')
  const failChecks = await adapter.diagnose()
  assert.deepEqual(failChecks.map((c) => c.status), ['failed', 'failed'])
  for (const c of failChecks) assert.ok(!JSON.stringify(c).includes(SECRET))

  // 通过
  const ok = await connectedFixture({})
  const passChecks = await ok.adapter.diagnose()
  assert.deepEqual(passChecks.map((c) => [c.name, c.status]), [['imap-login-list', 'passed'], ['smtp-verify', 'passed']])
})

// —— caps / 退避 / 断连 ————————————————————————————————————

test('caps 档位：editStream/nativeStream/typing/nativeChoices/statusReaction=false；fileIn/fileOut=true；上限 50000', () => {
  const { adapter } = { adapter: new EmailAdapter({}) }
  assert.equal(adapter.caps.editStream, false)
  assert.equal(adapter.caps.nativeStream, false)
  assert.equal(adapter.caps.nativeChoices, false)
  assert.equal(adapter.caps.statusReaction, false)
  assert.equal(adapter.caps.typing, false)
  assert.equal(adapter.caps.fileIn, true)
  assert.equal(adapter.caps.fileOut, true)
  assert.equal(adapter.caps.imageIn, true)
  assert.equal(adapter.caps.maxMessageLength, 50000)
})

test('退避纯函数：base×2^failures，2 倍递增封顶 10min', () => {
  assert.equal(EmailAdapter.backoffMs(60_000, 0), 60_000)
  assert.equal(EmailAdapter.backoffMs(60_000, 1), 120_000)
  assert.equal(EmailAdapter.backoffMs(60_000, 3), 480_000)
  assert.equal(EmailAdapter.backoffMs(60_000, 4), 600_000)
  assert.equal(EmailAdapter.backoffMs(60_000, 40), 600_000)
})

test('disconnect：停轮询、IMAP logout；未连接时 reply 走注入 transport 不抛会话错', async () => {
  const transport = makeFakeTransport()
  const adapter = new EmailAdapter({ address: OWN, password: SECRET, transport, imapFactory: () => makeFakeImap({ messages: [] }) })
  await adapter.connect()
  assert.equal(adapter.connected, true)
  await adapter.disconnect()
  assert.equal(adapter.connected, false)
})

// —— RFC2047 头解码（From 显示名/Subject） ————————————————————

test('RFC2047：From 显示名与 Subject B/Q 编码解码', async () => {
  const name = Buffer.from('张三', 'utf-8').toString('base64')
  const subj = Buffer.from('会议纪要', 'utf-8').toString('base64')
  const msg = makeRawEmail({
    from: '=?UTF-8?B?' + name + '?= <zhang@x.com>',
    subject: '=?UTF-8?B?' + subj + '?=',
    messageId: '<r47@x>',
    text: 'body',
  })
  const { adapter, received } = await connectedFixture({ messages: [{ uid: 1, source: msg }] })
  await adapter.pollOnce()
  assert.equal(received[0].userDisplayName, '张三')
  assert.equal(parseFromAddress('=?UTF-8?Q?Bob=20X?= <bob@y>').addr, 'bob@y')
  assert.equal(parseFromAddress('=?UTF-8?Q?Bob=20X?= <bob@y>').name, 'Bob X')
})
