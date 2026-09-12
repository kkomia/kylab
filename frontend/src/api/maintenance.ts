/**
 * 存储维护接口（对应后端 /api/v1/maintenance/*，v17）。
 *
 * 两个端点都是管理员专属：
 * - 概览告诉你**空间都花在哪**（尤其是"可回收"那一项——SQLite 删数据不会
 *   把文件变小，不看这个数字会以为删了没用）；
 * - 整理会丢掉无主的向量分区并 VACUUM。VACUUM 要重写整个数据库文件，
 *   所以它只能由用户显式点击触发，这里不做任何自动轮询或自动重试。
 */

import { request } from './client'

export interface StorageOverview {
  /** 数据库文件的实际大小。 */
  file_bytes: number
  /** 有效数据 ≈ 文件 − 可回收。 */
  data_bytes: number
  /** 可回收空间（SQLite freelist：删数据后留下的空页，要 VACUUM 才还回去）。 */
  free_bytes: number
  /** 向量分区数量。每个分区写入第一个向量就占一个 4MB 块，所以它值得单独看。 */
  partitions: number
  /** 无主的向量分区（知识库已删、表留在库里）。 */
  orphans: string[]
}

export function getStorageOverview(): Promise<StorageOverview> {
  return request('/maintenance/storage')
}

/** 丢掉无主向量分区并 VACUUM，返回**整理之后**的概览。 */
export function compactStorage(): Promise<StorageOverview> {
  return request('/maintenance/compact', { method: 'POST' })
}
