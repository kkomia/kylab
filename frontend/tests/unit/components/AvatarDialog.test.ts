import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AvatarDialog from '@/components/settings/AvatarDialog.vue'

/**
 * 换头像（v0.29）。
 *
 * 这里盯的是**上传前那一步**：图在浏览器里先裁成正方形并缩到 256px 再传
 * （服务端不装成像库，它只守"是不是图、有多大"）。jsdom 没有 canvas 与
 * createImageBitmap，所以把它们换成最小的桩——测的是这条路径本身，
 * 不是浏览器的图像解码。
 */

const setAvatar = vi.fn()
const removeAvatar = vi.fn()
const notifyError = vi.fn()
const notifySuccess = vi.fn()

vi.mock('@/composables/useSession', () => ({
  setAvatar: (...a: unknown[]) => setAvatar(...a),
  removeAvatar: (...a: unknown[]) => removeAvatar(...a),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError, notifySuccess, notify: vi.fn(), notifyWarning: vi.fn() }),
}))

function stubCanvas(): void {
  // jsdom 三样都没有：解码、canvas、对象 URL。桩只补这三样，
  // 组件里"裁正方形 + 缩到 256"的顺序仍然按真代码走。
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:preview',
    revokeObjectURL: () => undefined,
  })
  vi.stubGlobal('createImageBitmap', async () => ({
    width: 800,
    height: 600,
    close: () => undefined,
  }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob(['scaled'], { type: 'image/png' }))
  })
}

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(AvatarDialog, {
    props: { open: true, name: '小又', url: '', ...props },
    global: { stubs: { teleport: true } },
  })
}

async function pickFile(wrapper: ReturnType<typeof mountDialog>): Promise<void> {
  const input = wrapper.find('input[type="file"]')
  const file = new File(['raw'], 'photo.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await vi.waitFor(() => expect(wrapper.find('.avatar-preview').exists()).toBe(true))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  stubCanvas()
  setAvatar.mockResolvedValue(undefined)
  removeAvatar.mockResolvedValue(undefined)
})

describe('AvatarDialog', () => {
  it('还没选图时显示当前头像，保存按钮是禁用的', () => {
    const wrapper = mountDialog({ url: '/api/v1/avatars/u1?sig=x' })

    expect(wrapper.find('img').attributes('src')).toContain('/api/v1/avatars/u1')
    const save = wrapper.findAll('button').find((node) => node.text().includes('保存'))!
    expect(save.attributes('disabled')).toBeDefined()
  })

  it('选一张图 → 先看预览，再保存时上传缩好的那一份', async () => {
    const wrapper = mountDialog()
    await pickFile(wrapper)

    // 预览用的是本地对象 URL（还没上传）：用户改主意时桶里不该留一张没人知道的图
    expect(wrapper.find('.avatar-preview').exists()).toBe(true)

    await wrapper
      .findAll('button')
      .find((node) => node.text().includes('保存'))!
      .trigger('click')

    await vi.waitFor(() => expect(setAvatar).toHaveBeenCalled())
    const file = setAvatar.mock.calls[0][0] as File
    expect(file.type).toBe('image/png')
    expect(wrapper.emitted('changed')).toBeTruthy()
  })

  it('去掉头像：有图时才给这个按钮，调删除并通知外面', async () => {
    const wrapper = mountDialog({ url: '/api/v1/avatars/u1?sig=x' })

    await wrapper
      .findAll('button')
      .find((node) => node.text().includes('去掉头像'))!
      .trigger('click')

    await vi.waitFor(() => expect(removeAvatar).toHaveBeenCalled())
    expect(wrapper.emitted('changed')).toBeTruthy()
    // 从没设过头像时不摆这个按钮：它此刻什么也做不了
    expect(
      mountDialog()
        .findAll('button')
        .find((node) => node.text().includes('去掉头像')),
    ).toBeUndefined()
  })

  it('不是图片的文件当场说清楚，不进入预览', async () => {
    const wrapper = mountDialog()
    const input = wrapper.find('input[type="file"]')
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })

    await input.trigger('change')

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith('请选一张图片'))
    expect(wrapper.find('.avatar-preview').exists()).toBe(false)
  })
})
