# Changelog

本项目版本号遵循语义化版本；发布面与宿主兼容矩阵见 `scripts/hosts.mjs`（README 管理块同源）。

## 0.0.1（首发占位，tag=next）

预发布占位版本，非推荐安装线；语义为「协议层与跨版本骨架完成、真机验收进行中」。

### Added

- 跨版本窄腰（host-compat）：services 能力探测冻结 / settings-compat 三态代际分派（gen1/gen2/gen3）/ session-api（宿主 @Remote request-object 主形 + 位置参回退）/ interaction（waterfall 返回即接管）/ fs-api
- 会话引擎：每聊天串行队列、follow-before-prompt 投递状态机（assistant/message 按 step 聚合 → 流式快照）、turn/end 六因映射、看门狗兜底
- 命令面板 15 命令（/help /status /new /stop /steer /models /model /reasoning /presets /preset /workspace(s) /session(s) /menu），能力缺位=降级文案不抛
- P0 五渠道协议层（净室重实现）：微信 iLink（官方 ClawBot 协议：长轮询/context_token/AES-128-ECB CDN 全链/typing/扫码绑定）、Telegram（Bot API 长轮询+编辑流式+Markdown 回退链）、Discord（Gateway v10+Thread 模型+表格转竖排）、飞书（官方 SDK 长连接+逐步消息）、企业微信智能机器人（长连接 aibot 协议+stream 编辑流式）
- 审批与交互提问 IM 闭环（once-settle 状态机、发起者限定、fail-closed、5 分钟取消）
- 图片输入公共层（宿主 capability 元数据判视觉、三重预算、渠道图片下载）
- 多账号管理：AccountManager（原子文件态、secret 单向入库、暂停/恢复/白名单/诊断）+ 管理 API（requestRejection/Host/Origin/Cookie 三查、零凭据回包）+ client 半账号 CRUD 面板（九语）
- 门禁四件套：typecheck / 单测 164 项 / dist 冒烟 / hosts:check 单源下发；peer 全枚举 0.1.2-rc.1..0.2.1-rc.1（11 tag）

### Known (intentionally pre-release)

- 各渠道真机 round-trip 验收进行中（T1.10）
- 飞书流式卡片档/QR 创建机器人、企微原生进度显示、微信设置页扫码 UI 流为后续迭代
