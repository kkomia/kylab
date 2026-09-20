import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ConversationHistoryPanel from '@/components/layout/ConversationHistoryPanel.vue'
import { resetResizeObservers } from '../../setup'

/**
 * 历史会话面板（v0.17，照 Kimi 的做法）。
 *
 * 这一页的价值在**回看**：用户来这儿找的是"上次聊的那个"。所以测三件事：
 *
 * 1. **分组与日期标签**：相对时间（今天/昨天/本周…）是回看时的索引方式，
 *    右侧那列「星期一」与分组标签必须自洽；
 * 2. **预览压平 Markdown**：参考图里那两行是纯文本，`**粗体**`、`[1]`、`#` 标记
 *    原样显示出来就是噪声（这是"看起来对不对"的核心）；
 * 3. **归档不是删除**：菜单里那一项是「归档」，而且归档后能取消。
 */

const listConversations = vi.fn()
const updateConversation = vi.fn()
const deleteConversation = vi.fn()

vi.mock('@/api/conversations', () => ({
  listConversations: (...args: unknown[]) => listConversations(...args),
  updateConversation: (...args: unknown[]) => updateConversation(...args),
  deleteConversation: (...args: unknown[]) => deleteConversation(...args),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  rewindConversation: vi.fn(),
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('vue-router')
  return {
    ...actual,
    useRoute: () => ({ path: '/chat', query: {} }),
    useRouter: () => ({ push: vi.fn() }),
  }
})

const notifyError = vi.fn()
const notifySuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError, notifySuccess, notify: vi.fn(), notifyWarning: vi.fn() }),
}))

function iso(daysAgo: number, hour = 10): string {
  const at = new Date()
  at.setDate(at.getDate() - daysAgo)
  at.setHours(hour, 0, 0, 0)
  return at.toISOString()
}

const ITEMS = [
  {
    id: 'conv_today',
    title: '今天聊的',
    kb_ids: [],
    model_pk: null,
    thinking: null,
    thinking_effort: null,
    pinned: false,
    workspace_id: null,
    archived_at: null,
    preview: '**结论**：先给判断。[1] 依据是 [[锂价]] 这段。',
    created_at: iso(0),
    updated_at: iso(0),
    message_count: 2,
  },
  {
    id: 'conv_yesterday',
    title: '昨天聊的',
    kb_ids: [],
    model_pk: null,
    thinking: null,
    thinking_effort: null,
    pinned: true,
    workspace_id: null,
    archived_at: null,
    preview: '',
    created_at: iso(1),
    updated_at: iso(1),
    message_count: 4,
  },
]

function mountPanel(open = true) {
  return mount(ConversationHistoryPanel, {
    props: { open },
    global: {
      stubs: {
        // 面板用 Teleport 到 body（为了不被 `.content` 的 overflow 裁掉）。
        // 测试里要把它 stub 掉——否则 `wrapper` 里什么都找不到，
        // 而现象是"页面全空"（看着像组件没渲染，其实是渲染到了 body 上）。
        Teleport: true,
        RouterLink: { template: '<a><slot /></a>', props: ['to'] },
        RowMenu: { template: '<div class="row-menu"><slot :close="() => {}" /></div>' },
        // **替身必须真的双向绑定**：只渲染 :value 不 emit `update:modelValue`，
        // 输入就不会写回 v-model，于是"搜了但没能搜"（第一版就是这么错的）
        AppInput: {
          // 外层用双引号，里面的 `'update:modelValue'` 才不会把字符串截断
          // （单引号套单引号是刚才那次"Transform failed"的原因）
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          props: ['modelValue'],
        },
        SkeletonBlock: true,
      },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetResizeObservers()
  setActivePinia(createPinia())
  listConversations.mockResolvedValue({ items: ITEMS })
})

describe('ConversationHistoryPanel', () => {
  it('打开时拉一份**带预览**的清单（侧栏那份不带，所以面板自己拉）', async () => {
    mountPanel()
    await vi.waitFor(() => expect(listConversations).toHaveBeenCalled())

    const [, , filter] = listConversations.mock.calls[0]
    expect(filter.withPreview).toBe(true)
  })

  it('按相对时间分组，右侧给星期/日期标签', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('今天聊的'))

    expect(wrapper.text()).toContain('今天')
    expect(wrapper.text()).toContain('昨天')
    // 昨天那条不显示"刚刚"这类模糊词，而是一个具体的日期标签/相对词
    expect(wrapper.findAll('.entry')).toHaveLength(2)
  })

  it('预览压平 Markdown：粗体标记与引用编号不该原样出现', async () => {
    // 参考图里那两行是纯文本。把 `**` 与 `[1]` 摆出来，回看时读到的就是噪声。
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('今天聊的'))

    const preview = wrapper.find('.entry-preview').text()
    expect(preview).not.toContain('**')
    expect(preview).toContain('结论')
  })

  it('没有回答的会话给一句说明，而不是空白', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('昨天聊的'))

    expect(wrapper.text()).toContain('（还没有回答）')
  })

  it('置顶过的会话带置顶标记', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('昨天聊的'))

    expect(wrapper.findAll('.pin').length).toBeGreaterThan(0)
  })

  it('归档：菜单里是「归档」而不是「删除」，点了走 archived=true', async () => {
    // **归档不是删除**：它不该出现在一个叫"删除"的项里，也不该发删除请求
    updateConversation.mockResolvedValue({ ...ITEMS[0], archived_at: iso(0) })
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('今天聊的'))

    // **精确文本**：`includes('归档')` 会先命中「已归档」那个 tab（它也含这两个字）
    const archiveButton = wrapper
      .findAll('.entry-menu button')
      .find((button) => button.text().trim() === '归档')
    expect(archiveButton).toBeTruthy()
    await archiveButton!.trigger('click')

    await vi.waitFor(() =>
      expect(updateConversation).toHaveBeenCalledWith('conv_today', { archived: true }),
    )
    expect(deleteConversation).not.toHaveBeenCalled()
  })

  it('「已归档」是另一档视图，且在那里能取消归档', async () => {
    listConversations.mockResolvedValue({
      items: [{ ...ITEMS[0], archived_at: iso(1) }],
    })
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('今天聊的'))

    const archivedTab = wrapper.findAll('button').find((b) => b.text() === '已归档')
    await archivedTab!.trigger('click')

    await vi.waitFor(() => {
      const [, , filter] = listConversations.mock.calls.at(-1)!
      expect(filter.archived).toBe(true)
    })
    // 等**行**渲染出来：请求发出后还有一段 loading（那时渲染的是骨架）
    await vi.waitFor(() => expect(wrapper.text()).toContain('取消归档'))
  })

  it('搜索走后端（不是只筛当前这一页）', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('今天聊的'))
    listConversations.mockClear()

    await wrapper.find('input').setValue('锂价')
    vi.advanceTimersByTime(400)
    // 定时器推进后回调是同步跑的，但 `load()` 里的 await 还要一轮微任务
    await vi.waitFor(() => {
      const [, q] = listConversations.mock.calls.at(-1) ?? []
      expect(q).toBe('锂价')
    })
    vi.useRealTimers()
  })

  it('关闭状态不渲染（它挂在 App 外壳上，一直存在）', () => {
    const wrapper = mountPanel(false)

    expect(wrapper.find('.history').exists()).toBe(false)
  })

  it('关闭按钮把 close 事件抛出去', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('历史会话'))

    await wrapper.find('.close').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('关闭手势（v0.26）', () => {
  it('Esc 收起：盖住内容区的浮层不该只剩"去右上角找 ×"', async () => {
    listConversations.mockResolvedValue({ items: [] })
    const wrapper = mount(ConversationHistoryPanel, { props: { open: true } })
    await flushPromises()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('关着的时候按 Esc **不发出** close：这个组件常驻在 App 里', async () => {
    // `v-if` 在 Teleport 内部，组件本身一直挂着；不加这道判断的话，
    // 别处（比如设置弹窗）按 Esc 会顺带 emit 一次没人要的 close
    listConversations.mockResolvedValue({ items: [] })
    const wrapper = mount(ConversationHistoryPanel, { props: { open: false } })
    await flushPromises()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })
})
