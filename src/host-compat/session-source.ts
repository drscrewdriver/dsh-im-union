/**
 * 跨版本窄腰·会话消息署名（source kind）。
 *
 * 断裂面：宿主 ≥0.1.7-rc.1 的 Session v4 要求生产者自有署名 kind
 * `plugin:<name>`，写旧形制（裸 kind:'plugin' + plugin 字段）会触发
 * SessionFormatError 整轮失败；老线反过来——写 `plugin:<name>` 可能不被识别。
 * 判定用设置面代际作代理（gen3 ⇔ ≥0.1.7 线，两断裂面由同一次宿主换代引入），
 * 该代理关系须在逐线矩阵中坐实（checklist B7），矩阵红一格即改探测面。
 */
import type { UnionCapabilities } from './services.js'

export const PLUGIN_NAME = 'dsh-im-union'

export interface MessageSource {
  kind: string
  plugin?: string
}

/** 注入会话的引导/引用/来源信息应携带的署名对象。 */
export function messageSourceFor(caps: UnionCapabilities): MessageSource {
  if (caps.settingsGeneration === 'gen3') {
    return { kind: `plugin:${PLUGIN_NAME}` }
  }
  return { kind: 'plugin', plugin: PLUGIN_NAME }
}
