/**
 * 插件包接口（`/api/v1/plugins`，v0.43）。
 *
 * **本地市场 = 目录本身**：插件是磁盘上的"一个目录 + 一份 plugin.json"，
 * 放进 `user_dir` 就是上架。所以这一组只有两个动作：看列表、启停。
 *
 * 三条与界面直接相关的约定：
 *
 * 1. 契约来自后端的 OpenAPI（`./schema.d.ts`，由 `scripts/gen_api_types.py` 生成），
 *    后端加字段这里跟着变——手抄一份必然漂。
 * 2. **加载失败的插件也在列表里**（`loaded=false` + `error`）：界面必须把原因显示出来，
 *    静默藏掉会让用户以为插件没装上。
 * 3. **能力面四类都还没接执行**：每一类的 `status` 里写着"未实现"，
 *    界面上要照它显示——不能让人以为命令真的能被执行。
 */

import { request } from './client'
import type { components } from './schema'

/** 插件提供的一样东西（四类能力面之一：skill / command / hook / tool）。 */
export type PluginComponent = Required<components['schemas']['PluginComponentOut']>

/** 一个插件（本地市场里的一条）。加载失败的也在这里面。 */
export type PluginPack = Required<components['schemas']['PluginOut']>

/** 列表 + 状态栏要的几个数 + 两条发现源。 */
export type PluginList = Omit<Required<components['schemas']['PluginListOut']>, 'items'> & {
  /** **元素级还要收窄一次**：`Required<>` 只在顶层生效，`items` 里每一项仍是
      "字段可空"的 schema 形状，直接赋值会与 `PluginPack` 对不上。 */
  items: PluginPack[]
}

export function listPlugins(): Promise<PluginList> {
  return request<PluginList>('/plugins')
}

/** 启用。内置的顺带解除屏蔽（后端那条路会删掉屏蔽标记）。 */
export function enablePlugin(pluginId: string): Promise<PluginPack> {
  return request<PluginPack>(`/plugins/${encodeURIComponent(pluginId)}/enable`, { method: 'POST' })
}

/** 停用。**不碰插件目录**：只写一条状态，内置的另记一条屏蔽标记。 */
export function disablePlugin(pluginId: string): Promise<PluginPack> {
  return request<PluginPack>(`/plugins/${encodeURIComponent(pluginId)}/disable`, { method: 'POST' })
}
