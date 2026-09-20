/**
 * 剪贴板（开发计划 §12.205）。
 *
 * 这一组用例盯的是**失败之后还有没有路**：异步剪贴板在文档失焦时会抛
 * `NotAllowedError`（实测的原话是 "Document is not focused."），而用户点了按钮
 * 就该拿到东西。所以每条失败路径都要有用例，否则下次有人把兜底删掉，
 * 只会看到"表面对齐了、实测又复制不了"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyText, selectNode } from '@/composables/clipboard'

/** 换掉 `navigator.clipboard`（jsdom 里本来没有它）。传 `null` 表示"这个环境没有"。 */
function stubClipboard(impl: ((text: string) => Promise<void>) | null): void {
  if (impl === null) {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    return
  }
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(impl) },
    configurable: true,
  })
}

/** jsdom 不实现 `execCommand`，需要用时自己挂一个。 */
function stubExecCommand(impl: (() => boolean) | null): void {
  Object.defineProperty(document, 'execCommand', {
    value: impl === null ? undefined : vi.fn(impl),
    configurable: true,
    writable: true,
  })
}

const focused = async (text: string): Promise<void> => {
  void text
}

/** 文档失焦时 Chrome 的原话。 */
const notFocused = async (): Promise<void> => {
  throw new DOMException('Document is not focused.', 'NotAllowedError')
}

beforeEach(() => {
  stubExecCommand(null)
})

afterEach(() => {
  stubClipboard(null)
  stubExecCommand(null)
  document.body.innerHTML = ''
  document.getSelection()?.removeAllRanges()
})

describe('copyText', () => {
  it('异步剪贴板可用时就走它，不碰 execCommand', async () => {
    stubClipboard(focused)
    const legacy = vi.fn(() => true)
    stubExecCommand(legacy)

    await expect(copyText('docker manifest inspect x')).resolves.toBe(true)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('docker manifest inspect x')
    expect(legacy).not.toHaveBeenCalled()
  })

  it('失焦（NotAllowedError）时退回 execCommand，文本真的交到了那个临时输入框', async () => {
    stubClipboard(notFocused)
    let captured = ''
    let areaCount = 0
    stubExecCommand(() => {
      // execCommand 拷的是"当前文档里被选中的那个元素"，所以这里读的是真实的
      // DOM 状态，而不是一个被 mock 掉的参数——这才证明兜底那条路拿得到内容。
      // （不用 `document.activeElement`：jsdom 里 `select()` 不会改它。）
      const area = document.querySelector('textarea')
      captured = area?.value ?? ''
      areaCount = document.querySelectorAll('textarea').length
      return true
    })

    await expect(copyText('a\tb\nc')).resolves.toBe(true)
    expect(captured).toBe('a\tb\nc')
    // 临时输入框在调用期间必须在文档里（不在文档里选不中），
    expect(areaCount).toBe(1)
    // ……调完必须收干净，不能把隐藏输入框留在页面上
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('两条路都失败：返回 false，且不留临时输入框、不动用户原来的选中', async () => {
    stubClipboard(notFocused)
    stubExecCommand(() => false)
    const paragraph = document.createElement('p')
    paragraph.textContent = '用户自己选中的一句话'
    document.body.appendChild(paragraph)
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    document.getSelection()?.addRange(range)

    await expect(copyText('复制这段')).resolves.toBe(false)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
    expect(document.getSelection()?.toString()).toBe('用户自己选中的一句话')
  })

  it('环境里连异步剪贴板都没有（老内核）时直接走兜底', async () => {
    stubClipboard(null)
    stubExecCommand(() => true)

    await expect(copyText('x')).resolves.toBe(true)
  })

  it('空文本不算复制成功：不该让用户以为粘出来会有东西', async () => {
    stubClipboard(focused)
    const legacy = vi.fn(() => true)
    stubExecCommand(legacy)

    await expect(copyText('')).resolves.toBe(false)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(legacy).not.toHaveBeenCalled()
  })
})

describe('selectNode', () => {
  it('把节点内容选成选区，让用户按一下 Ctrl+C 就能拿到', () => {
    const pre = document.createElement('pre')
    pre.textContent = 'npm run dev'
    document.body.appendChild(pre)

    expect(selectNode(pre)).toBe(true)
    expect(document.getSelection()?.toString()).toBe('npm run dev')
  })

  it('空节点不承诺"已替你选中"', () => {
    const empty = document.createElement('pre')
    document.body.appendChild(empty)

    expect(selectNode(empty)).toBe(false)
  })

  it('没有节点可选中时返回 false，交给调用方如实报失败', () => {
    expect(selectNode(null)).toBe(false)
  })
})
