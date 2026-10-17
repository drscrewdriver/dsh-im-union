/**
 * 渠道注册表：id → 懒加载工厂。适配器文件动态 import，
 * 未配置的渠道 SDK 永不进 require 缓存（P0 运行时依赖懒加载纪律）。
 * 已实现渠道的工厂表在模块加载时静态登记——「实现度」是代码事实，
 * 不依赖运行时初始化顺序（校验/设置页灰显都读它）。新渠道随实现追加。
 */
import type { ChannelAdapter, ChannelFactory } from './types.js'
import { CHANNEL_META } from './meta.js'

interface RegistryEntry {
  factory: ChannelFactory
}

const factories = new Map<string, RegistryEntry>()

export function registerChannel(id: string, factory: ChannelFactory): void {
  if (CHANNEL_META[id] === undefined) {
    throw new Error(`未声明元数据的渠道: ${id}（先在 meta.ts CHANNEL_META 登记）`)
  }
  factories.set(id, { factory })
}

export function hasChannel(id: string): boolean {
  return factories.has(id)
}

export async function createAdapter(
  id: string,
  options: Parameters<ChannelFactory>[0],
): Promise<ChannelAdapter> {
  const entry = factories.get(id)
  if (entry === undefined) throw new Error(`渠道 ${id} 的适配器尚未实现（分期见 tasks.md）`)
  return entry.factory(options)
}

/** 已具备实现能力的渠道 id（设置页据此灰显"即将支持"）。 */
export function implementedChannels(): string[] {
  return [...factories.keys()]
}

// 已实现渠道（懒加载工厂；import 只拉注册表本体，适配器模块首次 createAdapter 才进缓存）。
registerChannel('telegram', async (options) => (await import('./telegram.js')).createTelegramAdapter(options))
registerChannel('discord', async (options) => (await import('./discord.js')).createDiscordAdapter(options))
