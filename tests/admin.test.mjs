import test from 'node:test'
import assert from 'node:assert/strict'
import { validateMutation, BASE_PATH, CLIENT_HEADER } from '../lib/admin/api.js'

const req = (method, headers) => ({ method, headers })

test('GET/HEAD/OPTIONS 免检', () => {
  assert.equal(validateMutation(req('GET', {})), undefined)
  assert.equal(validateMutation(req('HEAD', {})), undefined)
  assert.equal(validateMutation(req('OPTIONS', {})), undefined)
})

test('POST 非 JSON → 415', () => {
  assert.equal(validateMutation(req('POST', { 'content-type': 'text/plain' })), 415)
  assert.equal(validateMutation(req('POST', {})), 415)
})

test('POST JSON 缺客户端标识头 → 400', () => {
  assert.equal(validateMutation(req('POST', { 'content-type': 'application/json' })), 400)
})

test('POST JSON + 客户端标识头 → 放行', () => {
  assert.equal(
    validateMutation(req('POST', { 'content-type': 'application/json; charset=utf-8', [CLIENT_HEADER]: '1' })),
    undefined,
  )
})

test('BASE_PATH 与包名一致（管理面路径纪律）', () => {
  assert.equal(BASE_PATH, '/api/dsh-im-union')
})
