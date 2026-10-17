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

- @larksuiteoapi/node-sdk (MIT) — Feishu/Lark bot long-connection SDK (its WS
  handshake/signature surface is a private protocol, so the official SDK is used
  instead of a clean-room reimplementation; lazily imported)
- @whiskeysockets/baileys (MPL-2.0) — WhatsApp Web multi-device protocol library
  (lazily imported; only the WhatsApp channel touches it)
- qrcode (MIT) — QR PNG data-URL rendering for the WeChat iLink / WhatsApp
  scan-to-bind flows (lazily imported)

Everything else (Telegram, Discord, Slack, QQ, DingTalk, WeCom bot long-connection,
WeCom self-built app callback crypto, WeChat iLink transport, Matrix CS API) is
implemented directly against public protocol documents with ZERO runtime
dependencies (Node >= 22 global fetch/WebSocket + node:crypto/node:zlib only).
Earlier drafts of this file listed dingtalk-stream, @wecom/aibot-node-sdk and
@tencent-connect/qqbot-connector; those SDKs were never adopted — the respective
channels are zero-dependency clean-room implementations (corrected at 0.1.0).

Optional external tools: ffmpeg (system binary, spawned only when the Feishu
voice tier is explicitly enabled; never bundled, never assumed present — the
feature degrades honestly when missing).
