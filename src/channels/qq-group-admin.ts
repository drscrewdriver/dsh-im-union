/**
 * QQ 普通群管理 —— 能力门控元数据与人话映射（P6/F6）。
 *
 * 依据 QQ 官方 api-v2「群聊管理」接口的开放度分档（2026 实测，与 dsh-qqbot 侧同源事实核对）：
 *   🔴 未开放（内邀中）：成员列表 / 成员信息 —— 调用得 11253（仅白名单/未开放）；
 *   🟡 门槛=机器人为群管理员：入群申请列表/审批、群禁言查询/设置、群消息撤回（2 分钟窗口）；
 *   🟢 踢人（batch_remove_members）：2026-10-20 起后台「权限」页可勾选，按错误码动态裁决、不硬关。
 *
 * 本文件只放「门控表 + 端点常量 + 错误码→人话」这类纯数据/纯函数，实际 REST 由 QqAdapter 复用
 * 其既有 token/http 面发起（见 qq.ts 群管方法），避免另起一套凭证缓存。
 *
 * 端点（base=https://api.bot.qq.com，鉴权头 QQBot {access_token}）：
 * - 入群申请列表  GET  /v2/groups/{gid}/join_request_list
 * - 审批入群申请  POST /v2/groups/{gid}/approval_join_request/{member_openid}  {op:'approve'|'decline', join_request_id?}
 * - 群禁言查询    GET  /v2/groups/{gid}/restrict_chat_setting
 * - 设置群禁言    POST /v2/groups/{gid}/restrict_chat_setting  {members:[{op:'add'|'del', member_openid, mute_expire_at}]}
 * - 撤回群消息    DELETE /v2/groups/{gid}/messages/{message_id}   （仅机器人自己发的，窗口 2 分钟）
 */

/** 群管能力门控：UI/命令据此裁决；官方开放后把对应项 open 改 true 即可点亮，未开门一律拒绝不猜发。 */
export interface QqGroupGate {
  readonly open: boolean
  readonly human: string
}

export const QQ_GROUP_FEATURE_GATES: Record<string, QqGroupGate> = {
  listJoinRequests: { open: true, human: '入群申请列表：机器人需为该群管理员' },
  approveJoinRequest: { open: true, human: '入群申请审批：机器人需为该群管理员' },
  getMuteState: { open: true, human: '群禁言状态查询：机器人需为该群管理员' },
  setMute: { open: true, human: '设置禁言：机器人需为该群管理员（仅普通成员，最长 30 天，单次 ≤20 人）' },
  recallMessage: { open: true, human: '撤回群消息：仅机器人自己发的、2 分钟窗口内' },
  // 内邀中：不调用、命令侧直接告知未开放（开放后改 open:true 即自动可用）。
  listMembers: { open: false, human: '获取群成员列表：官方尚未开放（内邀中），等待公测后自动可用' },
  getMemberInfo: { open: false, human: '获取群成员信息（含昵称）：官方标注「内邀接入中」，申请到白名单后自动可用' },
}

/** 官方群管/权限相关错误码 → 面向用户的一句话（人话），映射不到回落通用文案。 */
export function qqGroupErrHuman(code: string | number): string {
  const c = String(code)
  const table: Record<string, string> = {
    '11253': '该能力官方尚未开放/无接口权限（内邀中或需白名单），请联系平台运营或改为管理员后重试',
    '11703': '机器人无该接口权限：需为该群管理员，或该能力尚未对应用开放',
    '11201': '机器人不在该群，或群 openid/参数错误',
    '40103004': '不能操作该成员：群主/管理员/机器人不可被禁言（只能禁普通成员）',
    '40101': '频控：请求太快，稍等再试',
    '401': '访问凭证无效，请刷新后重试',
    '403': '机器人缺少群管理员身份或未授权',
    '11001': '接口或参数不正确（多为路径/字段写错）：检查 URL 与参数',
  }
  return table[c] ?? `调用失败（错误码 ${c}），请稍后重试`
}

/** 单个群管 REST 调用的返回形态：成功带 data，失败带 code + human（UI/命令直接展示 human）。 */
export type QqGroupResult<T> = { ok: true; data: T } | { ok: false; code: string; human: string }
