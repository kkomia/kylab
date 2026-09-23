/**
 * 把签名链接变成字节（或文本）。
 *
 * **字节由我们自己取**（与旧 `OfficePreview.vue` 同一条）：签名链接是相对路径、
 * 不带鉴权头，`fetch` 拿到 `ArrayBuffer` 再交给渲染器——比让三个库各自去猜怎么取
 * 更可控，也让"取不到"有统一的报错位（三处各写一遍 fetch，就会有三套报错文案）。
 *
 * 两个钩子分开，因为**要的东西不一样**：
 *
 * - `useRemoteBuffer`：Office 三件套要 `ArrayBuffer`（docx-preview / pptx-preview /
 *   exceljs 三家都收字节，不收 Blob 也不收 base64）；
 * - `useRemoteText`：Markdown 与纯文本要字符串。**已经内联给过来的就不要再取一次**
 *   （文档接口的阅读视角直接回 `text`，那是它已经解码好的）。
 *
 * 三条共同的纪律：
 *
 * 1. **换 URL 就重来**：链接会过期（后端默认十分钟），重新签发后必须重新取；
 * 2. **卸载即中止**：`AbortController` 收掉在飞的请求，避免把结果写进已卸载的组件；
 * 3. **失败留下原因**：`HTTP 404` 与"网络不可达"都是用户要看到的区别。
 */
import { useEffect, useState } from 'react'

import { reasonOf } from './notes'

export interface RemoteBuffer {
  loading: boolean
  /** 空串 = 没出错。 */
  failure: string
  buffer: ArrayBuffer | null
}

export interface RemoteText {
  loading: boolean
  failure: string
  text: string
}

/** 取不到链接时的那句话（后端没给 url / 上层还没拿到签名）。 */
export const NO_URL = '拿不到预览链接'

async function readBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.arrayBuffer()
}

/** Office 三件套的字节。`url` 为空即失败（不留一个永远转圈的框）。 */
export function useRemoteBuffer(url: string | null | undefined): RemoteBuffer {
  const [state, setState] = useState<RemoteBuffer>({ loading: true, failure: '', buffer: null })

  useEffect(() => {
    if (!url) {
      setState({ loading: false, failure: NO_URL, buffer: null })
      return
    }
    const controller = new AbortController()
    let alive = true
    // 换链接时先回到加载态：旧的字节留在屏幕上会让人以为"换了一份文件却没反应"
    setState({ loading: true, failure: '', buffer: null })
    void (async () => {
      try {
        const buffer = await readBuffer(url, controller.signal)
        if (alive) setState({ loading: false, failure: '', buffer })
      } catch (cause) {
        if (!alive) return // 主动中止不算失败
        setState({ loading: false, failure: reasonOf(cause, '读取失败'), buffer: null })
      }
    })()
    return () => {
      alive = false
      controller.abort()
    }
  }, [url])

  return state
}

/**
 * 文本类的内容。**`inline` 优先**：后端已经把解码好的文本给了，
 * 再去 fetch 一遍是同一次会话里多跑一趟网络，还会因为多余的一次失败把好好的内容变成报错。
 */
export function useRemoteText(url: string | null | undefined, inline?: string | null): RemoteText {
  const provided = inline ?? null
  const [state, setState] = useState<RemoteText>(() =>
    provided === null
      ? { loading: true, failure: '', text: '' }
      : { loading: false, failure: '', text: provided },
  )

  useEffect(() => {
    if (provided !== null) {
      setState({ loading: false, failure: '', text: provided })
      return
    }
    if (!url) {
      setState({ loading: false, failure: NO_URL, text: '' })
      return
    }
    const controller = new AbortController()
    let alive = true
    setState({ loading: true, failure: '', text: '' })
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const text = await response.text()
        if (alive) setState({ loading: false, failure: '', text })
      } catch (cause) {
        if (!alive) return
        setState({ loading: false, failure: reasonOf(cause, '读取失败'), text: '' })
      }
    })()
    return () => {
      alive = false
      controller.abort()
    }
  }, [url, provided])

  return state
}
