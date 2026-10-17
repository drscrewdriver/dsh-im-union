# Security policy (dsh-im-union)

不可让渡红线（实现与评审均以此为准）：

1. **凭据存储**：宿主 `ctx.credentials` 为主存储；仅当宿主无该服务时回退到
   profile 目录下的文件 vault（原子写 tmp+rename、POSIX 0600 / Windows 继承 ACL）。
   vault 文件损坏时抛错，**绝不覆盖唯一副本**。secret 单向提交给宿主，任何
   RPC/HTTP 响应与状态接口不回传 token、secret、原始用户标识或内部异常细节。
2. **管理 API**：`/api/dsh-im-union` 每个请求先过宿主 `connection.requestRejection`
   （Host/trustedHosts + Origin + 登录 Cookie 三查）；`connection` 服务缺失时返回
   503，**不降级为匿名可用**。写请求要求 `Content-Type: application/json` +
   客户端标识头，body 上限 1 MiB；响应携带 `Cache-Control: no-store`。
3. **工具审批**：审批只在任务发起的原聊天闭环处理；群聊仅接受任务发起者回复；
   永不回退网页端处理；审批消息发送失败按拒绝处理；5 分钟无回复取消动作；
   任何路径不自动恢复 allowAllUsers / 开放响应模式。
4. **入站准入**：先验 userId；私聊白名单为空即拒；群聊仅响应显式 @ 本机器人。
5. **投递语义**：平台接受 ≠ 已送达（Receipt）；发送结果不确定时不自动重发，
   宁可漏发不双发。

漏洞报告：仓库 GitHub Security Advisory。
