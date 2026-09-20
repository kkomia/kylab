import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ConversationRowMenu from '@/components/layout/ConversationRowMenu.vue'
import { resetResizeObservers } from '../../setup'

/**
 * 会话行的「⋯」菜单（v0.25）。
 *
 * 它是**侧栏与会话面板共用**的那一份，所以这里钉的是两件"抽出来之后必须成立"的事：
 *
 * 1. **删除要确认，归档不确认**。删除是这一列里唯一不可逆的动作，而菜单是整行悬停
 *    才出现的——误点的代价高；归档可逆，加确认只会让常用动作变慢。
 * 2. **「移至项目」的动作真的是改归属**（`workspace_id`），不是"复制一份"之类；
 *    并且已经在某个项目里时能**移出去**——否则移进去就出不来了。
 */

const updateConversation = vi.fn()
const deleteConversation = vi.fn()
const listWorkspaces = vi.fn()

vi.mock('@/api/conversations', () => ({
  updateConversation: (...args: unknown[]) => updateConversation(...args),
  deleteConversation: (...args: unknown[]) => deleteConversation(...args),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  rewindConversation: vi.fn(),
}))

vi.mock('@/api/workspaces', () => ({
  listWorkspaces: (...args: unknown[]) => listWorkspaces(...args),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}))

const notifyError = vi.fn()
const notifySuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError, notifySuccess, notify: vi.fn(), notifyWarning: vi.fn() }),
}))

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv_1',
    title: '今天聊的',
    kb_ids: [],
    model_pk: null,
    thinking: null,
    thinking_effort: null,
    pinned: false,
    workspace_id: null,
    archived_at: null,
    preview: '',
    created_at: null,
    updated_at: null,
    message_count: 2,
    ...overrides,
  } as never
}

function mountMenu(item = conversation()) {
  return mount(ConversationRowMenu, {
    props: { item },
    global: {
      stubs: {
        // 弹窗在别的用例里各测各的；这里要的是"点下去发生了什么"，
        // 所以把 AppModal 摊平成它的内容，好让列表点得到
        AppModal: {
          props: { open: { type: Boolean, default: false } },
          template: '<div v-if="open" class="stub-modal"><slot /><slot name="footer" /></div>',
        },
      },
    },
  })
}

function menuItems(wrapper: ReturnType<typeof mountMenu>) {
  return wrapper.findAll('.menu-list button')
}

function itemNamed(wrapper: ReturnType<typeof mountMenu>, label: string) {
  return menuItems(wrapper).find((button) => button.text().trim() === label)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetResizeObservers()
  setActivePinia(createPinia())
  updateConversation.mockResolvedValue(conversation())
  deleteConversation.mockResolvedValue(undefined)
  listWorkspaces.mockResolvedValue({ items: [] })
})

describe('ConversationRowMenu', () => {
  it('没有项目时不摆「移至项目」——点开一个空列表比没有这一项更让人困惑', () => {
    const wrapper = mountMenu()

    expect(menuItems(wrapper).map((button) => button.text().trim())).toEqual([
      '置顶',
      '重命名',
      '归档',
      '删除',
    ])
  })

  it('删除先确认，点了确认才真的发请求', async () => {
    const wrapper = mountMenu()

    await itemNamed(wrapper, '删除')!.trigger('click')
    // **先确认**：确认框出现之前一个请求都不该发
    expect(deleteConversation).not.toHaveBeenCalled()

    const confirm = wrapper.find('.stub-modal button.button-danger')
    expect(confirm.exists()).toBe(true)
    await confirm.trigger('click')

    await vi.waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('conv_1'))
    expect(notifySuccess).toHaveBeenCalledWith('已删除')
  })

  it('归档**不**确认，直接走 archived=true（而且不碰删除接口）', async () => {
    const wrapper = mountMenu()

    await itemNamed(wrapper, '归档')!.trigger('click')

    await vi.waitFor(() =>
      expect(updateConversation).toHaveBeenCalledWith('conv_1', { archived: true }),
    )
    expect(deleteConversation).not.toHaveBeenCalled()
    // 文案要说清"能找回来"，否则用户会把它当成删除
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringContaining('查看全部会话'))
  })

  it('已在项目里时列出项目并标出当前那个，且能移出项目', async () => {
    listWorkspaces.mockResolvedValue({
      items: [
        {
          id: 'ws_1',
          name: '产品化',
          root_path: 'E:/a',
          description: '',
          kb_ids: [],
          conversation_count: 0,
          created_at: null,
          updated_at: null,
        },
        {
          id: 'ws_2',
          name: '另一个',
          root_path: 'E:/b',
          description: '',
          kb_ids: [],
          conversation_count: 0,
          created_at: null,
          updated_at: null,
        },
      ],
    })
    const wrapper = mountMenu(conversation({ workspace_id: 'ws_1' }))
    await vi.waitFor(() => expect(wrapper.text()).toContain('移至项目'))

    await itemNamed(wrapper, '移至项目')!.trigger('click')
    await wrapper.vm.$nextTick()

    const rows = wrapper.findAll('.move-row')
    expect(rows.map((row) => row.text())).toEqual(['产品化当前', '另一个', '移出项目'])

    // 移出：传 null，不是空字符串——后端用哨兵区分"不传"与"传 null"
    await rows[2].trigger('click')
    await vi.waitFor(() =>
      expect(updateConversation).toHaveBeenCalledWith('conv_1', { workspace_id: null }),
    )
  })

  it('点当前所在的那个项目不会白发一次请求', async () => {
    listWorkspaces.mockResolvedValue({
      items: [
        {
          id: 'ws_1',
          name: '产品化',
          root_path: 'E:/a',
          description: '',
          kb_ids: [],
          conversation_count: 0,
          created_at: null,
          updated_at: null,
        },
      ],
    })
    const wrapper = mountMenu(conversation({ workspace_id: 'ws_1' }))
    await vi.waitFor(() => expect(wrapper.text()).toContain('移至项目'))

    await itemNamed(wrapper, '移至项目')!.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.findAll('.move-row')[0].trigger('click')

    expect(updateConversation).not.toHaveBeenCalled()
  })

  it('动作做完把 `changed` 抛给调用方（侧栏不必刷，面板要）', async () => {
    const wrapper = mountMenu()

    await itemNamed(wrapper, '置顶')!.trigger('click')

    await vi.waitFor(() =>
      expect(updateConversation).toHaveBeenCalledWith('conv_1', { pinned: true }),
    )
    expect(wrapper.emitted('changed')).toBeTruthy()
  })
})
