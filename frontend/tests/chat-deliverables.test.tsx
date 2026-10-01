/**
 * 产物卡片的**图片档**（2026-10-01 用户批注）：图片产物直接铺成缩略图，hover 轻微放大。
 *
 * 钉住的是这一档的判据与兜底（一条一条对应施工口径）：
 *
 * 1. 位图后缀（png / jpg / jpeg / webp / gif）走图片卡：`getFileUrl(会话, artifact_id, 'inline')`
 *    换来的签名链接喂给 `<img>`（宽 100%、最高 200px、`object-cover`、12px 圆角、
 *    那 3% 的 hover 放大），点图 = 开文件抽屉直落这一份（沿用现有那条路，不另造 lightbox）；
 *    链接还在路上时先摆一块**同高**的 `Bg-Secondary` 占位（免得图一到位整条消息跳一下）；
 *    **下半行没有 36px 图标盒**（缩略图本身就是类型说明），名字与三个动作一个不少；
 * 2. 非图片产物照旧是图标盒那一整行（36px 方盒 + 名字 / 格式·大小·来源 + 三个动作），
 *    **连签名链接都不换**；
 * 3. 图加载失败（`onError`）→ 整张卡回退成行式卡片那一行；链接换不到也一样；
 * 4. **svg 不走图片卡**：内联 SVG 与本站**同源**、是脚本执行面（存储型 XSS），
 *    本仓的安全口径排除它（见 `Deliverables.tsx` 里 `IMAGE_FORMATS` 那段）。
 *
 * `useChat` 换成桩（卡片只读会话 id / 开抽屉 / 开「存进知识库」弹窗 / 库名这四样），
 * `getFileUrl` 换成 mock——真链接要后端的签名。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatArtifact } from '@/api/chat'

/** `useChat` 的桩：`Deliverables` 读的就是这四样。 */
const chatStub = {
  conversationId: 'c1',
  openFiles: vi.fn(),
  openIngest: vi.fn(),
  kbName: () => '',
}

vi.mock('@/features/chat/runtime/ChatProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat/runtime/ChatProvider')>()
  return { ...actual, useChat: () => chatStub }
})

vi.mock('@/api/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/conversations')>()
  // 下载那条路不在这一层验（它由 `api-conversations` / `chat-ui` 钉），给个空实现即可
  return { ...actual, getFileUrl: vi.fn(), downloadFile: vi.fn(async () => undefined) }
})

import { getFileUrl } from '@/api/conversations'
import { Deliverables } from '@/features/chat/ui/Deliverables'

/** 换出来的签名链接（相对路径，与后端给的那一形状相同）。 */
const SIGNED = '/api/v1/conversations/c1/files/download-url?key=art1&disposition=inline&sign=abc'

/** 一份产物：默认就是图片那一档，各用例按需要改后缀 / 名字。 */
function artifact(overrides: Partial<ChatArtifact> = {}): ChatArtifact {
  return {
    artifact_id: 'art1',
    name: '月度图表.png',
    size_bytes: 2048,
    format: 'png',
    where: '本会话',
    ...overrides,
  }
}

/** 一个能手动落定的 promise：钉住"链接还没到手"那一段（占位块在不在）。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * 卡片左边那一格图形盒（36px 方盒）：它只在**行式卡片**里（图片卡那一层的直接子节点
 * 是"缩略图按钮 + 下半行"，没有这一格）——所以它同时是"这是不是回退/非图片那一行"的判据。
 */
function iconBoxOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('li > span')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('产物卡片的图片档', () => {
  it('图片产物：签名链接铺成内联缩略图（cover / 圆角 / hover 放大），点图开抽屉预览', async () => {
    const pending = deferred<{ url: string; expires_at: number; name: string }>()
    vi.mocked(getFileUrl).mockReturnValue(pending.promise)
    const { container } = render(<Deliverables files={[artifact()]} />)

    // 链接还在路上：先占住同一块高度（灰底），此时还没有 `<img>`
    const holder = container.querySelector('li button span')
    expect(holder).not.toBeNull()
    expect(holder!.className).toContain('h-[200px]')
    expect(holder!.className).toContain('bg-[var(--Bg-Secondary)]')
    expect(screen.queryByRole('img')).toBeNull()

    await act(async () => pending.resolve({ url: SIGNED, expires_at: 0, name: '月度图表.png' }))

    const img = await screen.findByRole('img')
    expect(img).toHaveAttribute('src', SIGNED)
    // key 取产物在文件区的那个（`artifact_id`），而且要**点名 inline**（不然服务端按下载给）
    expect(getFileUrl).toHaveBeenCalledWith('c1', 'art1', 'inline')
    // 缩略图那一套：填满、cover、12px 圆角、最高 200px（`max-height` 约 200）
    expect(img.className).toContain('block')
    expect(img.className).toContain('w-full')
    expect(img.className).toContain('max-h-[200px]')
    expect(img.className).toContain('object-cover')
    expect(img.className).toContain('rounded-[12px]')
    // hover 那一下：`transform .3s` + 放 3%（缩放被圆角框裁在里面）
    expect(img.className).toContain('transition-transform')
    expect(img.className).toContain('duration-300')
    expect(img.className).toContain('hover:scale-[1.03]')
    const thumbButton = img.closest('button')!
    expect(thumbButton.className).toContain('cursor-zoom-in')
    expect(thumbButton.className).toContain('overflow-hidden')

    // 下半那一行还在：名字 / 格式·大小·来源 + 三个动作
    expect(img.closest('li')!.textContent).toContain('月度图表.png')
    expect(img.closest('li')!.textContent).toContain('PNG · 2.0 KB · 本会话')
    expect(screen.getByRole('button', { name: '预览' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '存进知识库' })).toBeInTheDocument()
    /*
      **下半行没有那一格 36px 图标盒**：缩略图本身就是类型说明，下面再摆一枚小图片图标是重复。
      两条一起钉——`li` 的直接子节点只剩"缩略图按钮 + 下半行"（图标盒是 `li > span`），
      整张卡里也找不到任何 `h-[36px]` 那一格。
    */
    expect(iconBoxOf(container)).toBeNull()
    expect(
      [...container.querySelectorAll('li span')].some((node) =>
        node.className.includes('h-[36px]'),
      ),
    ).toBe(false)

    // 点图 = 点「预览」：还是那只文件抽屉、还是直落这一份
    fireEvent.click(img)
    expect(chatStub.openFiles).toHaveBeenCalledWith({
      key: 'art1',
      name: '月度图表.png',
      kind: 'png',
    })
  })

  it('非图片产物：仍是图标盒那一行，且一个字节的签名链接都不换', () => {
    const { container } = render(
      <Deliverables files={[artifact({ format: 'docx', name: '季度报告.docx' })]} />,
    )

    expect(container.querySelector('img')).toBeNull()
    const box = iconBoxOf(container)
    expect(box).not.toBeNull()
    expect(box!.className).toContain('h-[36px]')
    expect(box!.className).toContain('bg-[var(--Bg-Secondary)]')
    expect(box!.querySelector('svg')).not.toBeNull()

    const row = container.querySelector('li')!
    expect(row.textContent).toContain('季度报告.docx')
    expect(row.textContent).toContain('DOCX · 2.0 KB · 本会话')
    expect(screen.getByRole('button', { name: '预览' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '存进知识库' })).toBeInTheDocument()

    expect(getFileUrl).not.toHaveBeenCalled()
  })

  it('图加载失败（onError）：整张卡回退成行式卡片那一行', async () => {
    vi.mocked(getFileUrl).mockResolvedValue({ url: SIGNED, expires_at: 0, name: '月度图表.png' })
    const { container } = render(<Deliverables files={[artifact()]} />)

    const img = await screen.findByRole('img')
    fireEvent.error(img)

    // 图和那块占位都不在了，回到图标盒那一行（动作一个不少）
    expect(screen.queryByRole('img')).toBeNull()
    const box = iconBoxOf(container)
    expect(box).not.toBeNull()
    expect(box!.className).toContain('h-[36px]')
    expect(screen.getByRole('button', { name: '预览' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '存进知识库' })).toBeInTheDocument()
  })

  it('签名链接换不到：也是回退成行式卡片，不留一块空灰在那儿', async () => {
    vi.mocked(getFileUrl).mockRejectedValue(new Error('HTTP 403'))
    const { container } = render(<Deliverables files={[artifact()]} />)

    await waitFor(() => expect(iconBoxOf(container)?.className).toContain('h-[36px]'))
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: '预览' })).toBeInTheDocument()
  })

  it('svg 产物不走图片卡（内联 SVG 是同源脚本执行面，本仓口径排除它）', () => {
    const { container } = render(
      <Deliverables files={[artifact({ format: 'svg', name: 'logo.svg' })]} />,
    )

    expect(container.querySelector('img')).toBeNull()
    const box = iconBoxOf(container)
    expect(box).not.toBeNull()
    expect(box!.className).toContain('h-[36px]')
    expect(getFileUrl).not.toHaveBeenCalled()
  })
})
