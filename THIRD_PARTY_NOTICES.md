# Third-party notices

dsh-im-union is a clean-room reimplementation. No source code is copied from the
projects below; capability inventory and public protocol knowledge informed
this design, and the listed upstream SDKs are consumed as external npm
dependencies only.

## Prior art (capability references, code NOT derived from)

- xmanrui/dsh-im — MIT License. Itself derives some protocol adapters from
  Tencent/openclaw-weixin (MIT), DingTalk-Real-AI/dingtalk-openclaw-connector,
  and @wecom/wecom-openclaw-cli (ISC); we re-implement against the same public
  platform APIs without porting any of that code.
- MichengAI/dsh-im-connect — Apache License 2.0 (includes the §3 patent grant
  with retaliation termination; no code ported).

## Runtime npm dependencies (consumed as-is, licenses per their packages)

- @larksuiteoapi/node-sdk (MIT) — Feishu/Lark bot long-connection SDK
- dingtalk-stream (MIT) — DingTalk Stream mode SDK
- @wecom/aibot-node-sdk — WeCom intelligent-bot WebSocket SDK
- @tencent-connect/qqbot-connector — QQ bot QR pairing helper (declared
  UNLICENSED upstream; used as an external dependency only, never vendored)
- qrcode (MIT) — QR rendering for scan-to-bind flows

P1/P2 additions will be listed here as they land (Baileys, @matrix-org/olm,
imapflow/nodemailer, sharp — none are dependencies at M0).
