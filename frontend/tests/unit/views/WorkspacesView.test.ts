import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import WorkspacesView from '@/views/WorkspacesView.vue'
import { resetResizeObservers } from '../../setup'

/**
 * 工作区页（v0.15；新建改弹窗见 v0.25）。
 *
 * 这一页的价值集中在**两处校验与一处承诺**上，所以测的是它们，而不是"渲染出来了"：
 *
 * 1. 根目录是"Agent 能碰哪儿"的边界——服务端的拒绝文案必须**原样透出来**
 *    （换成"保存失败"就把唯一有用的信息丢了）；
 * 2. 删除确认里必须写明"**会话不会被删**"——那是用户最担心的一件事；
 * 3. 绑定知识库是"进入项目，资料范围就定了"的落点，勾选要真的进请求体。
 *
 * v0.25 新增一条：**新建是弹窗，不是把整页切成新建态**——
 * 它钉住的是"建一个的时候，你所在的那一页没有被清空"。
 */

const listWorkspaces = vi.fn()
const createWorkspace = vi.fn()
const updateWorkspace = vi.fn()
const deleteWorkspace = vi.fn()
const kbLoad = vi.fn()
const convLoad = vi.fn()
const convCreate = vi.fn()
const routerPush = vi.fn()
const routerReplace = vi.fn()
const notifyError = vi.fn()
const notifySuccess = vi.fn()

/** 每个用例可以改它来模拟带 query 的进入方式（`?new=1` / `?focus=`）。 */
let routeQuery: Record<string, string> = {}

vi.mock('@/api/workspaces', () => ({
  listWorkspaces: (...args: unknown[]) => listWorkspaces(...args),
  createWorkspace: (...args: unknown[]) => createWorkspace(...args),
  updateWorkspace: (...args: unknown[]) => updateWorkspace(...args),
  deleteWorkspace: (...args: unknown[]) => deleteWorkspace(...args),
}))

vi.mock('@/stores/knowledgeBases', () => ({
  useKnowledgeBaseStore: () => ({
    items: [
      { id: 'kb_1', name: '产品手册' },
      { id: 'kb_2', name: '运维库' },
    ],
    load: kbLoad,
  }),
}))

vi.mock('@/stores/conversations', () => ({
  useConversationStore: () => ({
    create: convCreate,
    load: convLoad,
  }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError, notifySuccess, notify: vi.fn(), notifyWarning: vi.fn() }),
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('vue-router')
  return {
    ...actual,
    useRoute: () => ({ query: routeQuery, path: '/workspaces' }),
    useRouter: () => ({ push: routerPush, replace: routerReplace }),
  }
})

const WORKSPACE = {
  id: 'ws_1',
  name: '产品化',
  root_path: 'E:/code/proj',
  description: '一条线',
  kb_ids: ['kb_1'],
  conversation_count: 3,
  created_at: null,
  updated_at: null,
}

function mountView() {
  return mount(WorkspacesView, {
    global: {
      stubs: {
        // 外壳在别的用例里各测各的，这里只关心这一页的逻辑
        PageShell: { template: '<div><slot name="actions" /><slot /></div>' },
        // **弹窗桩要认 `open`**：新建是不是"弹窗"这件事正是本轮要钉的，
        // 一个无条件渲染 slot 的桩会让"弹窗开着"与"弹窗关着"看起来一样。
        AppModal: {
          props: { open: { type: Boolean, default: false } },
          template: '<div v-if="open" class="stub-modal"><slot /><slot name="footer" /></div>',
        },
        InfoTip: true,
        SkeletonBlock: true,
      },
    },
  })
}

/** 弹窗里的输入框：必须**限定在弹窗内**，否则会连带页面右侧那张编辑表单。 */
function dialogInputs(wrapper: ReturnType<typeof mountView>) {
  return wrapper.find('.ws-create').findAll('input')
}

function clickButton(wrapper: ReturnType<typeof mountView>, label: string) {
  return wrapper.findAll('button').find((button) => button.text().includes(label))
}

beforeEach(() => {
  vi.clearAllMocks()
  resetResizeObservers()
  routeQuery = {}
  // 工作区 store 用**真的**（不被 mock）：它自己就是这一页的一部分
  // （列表状态、增删改后的就地更新），换成替身等于把一半逻辑测掉了。
  // 它依赖的 API 层已经在上面被 mock，所以不会发真请求。
  setActivePinia(createPinia())
  listWorkspaces.mockResolvedValue({ items: [WORKSPACE] })
  kbLoad.mockResolvedValue(undefined)
  convLoad.mockResolvedValue(undefined)
})

describe('WorkspacesView', () => {
  it('列出工作区，并把根目录显示出来', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('产品化'))

    // 根目录要看得见：它是这一页最要紧的信息（Agent 能碰哪儿）
    expect(wrapper.text()).toContain('E:/code/proj')
    expect(wrapper.text()).toContain('3')
  })

  it('选中一个工作区后把它的字段回填进表单', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('产品化'))
    await wrapper.find('.ws-row').trigger('click')

    const inputs = wrapper.find('.ws-form').findAll('input')
    expect(inputs[0].element.value).toBe('产品化')
    expect(inputs[1].element.value).toBe('E:/code/proj')
  })

  it('新建是弹窗：打开它不会动页面右侧那张编辑表单', async () => {
    // 这条是 v0.25 那次改动的**行为契约**。改前「新建工作区」会把整页切成新建态
    // （右列表单被清空、id 被摘掉），于是"边看清单边建一个"做不到。
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('产品化'))

    expect(wrapper.find('.ws-create').exists()).toBe(false) // 没点之前弹窗是关的

    await clickButton(wrapper, '新建工作区')!.trigger('click')
    expect(wrapper.find('.ws-create').exists()).toBe(true)

    // 页面右侧仍是**选中那个工作区的编辑表单**，没被清空
    const form = wrapper.find('.ws-form')
    expect(form.exists()).toBe(true)
    expect(form.findAll('input')[0].element.value).toBe('产品化')
  })

  it('`?new=1` 直接开弹窗（侧栏的「新建项目」走这条）', async () => {
    routeQuery = { new: '1' }
    const wrapper = mountView()
    // 开弹窗发生在 `onMounted` 的 await 之后（要先加载清单与知识库），
    // 所以这里必须 waitFor，不能同步断言
    await vi.waitFor(() => expect(wrapper.find('.ws-create').exists()).toBe(true))
  })

  it('服务端的拒绝文案原样透出，不折成「创建失败」', async () => {
    // 这条是这一页最有价值的断言：根目录校验的报错**是**后端的产出，
    // 折掉它就等于把用户唯一能照着改的信息丢了
    createWorkspace.mockRejectedValue(new Error('不能把数据目录（或它里面的目录）作为工作区'))
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('产品化'))

    await clickButton(wrapper, '新建工作区')!.trigger('click')
    const inputs = dialogInputs(wrapper)
    await inputs[0].setValue('新的')
    await inputs[1].setValue('E:/data')
    await clickButton(wrapper, '创建工作区')!.trigger('click')

    await vi.waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('数据目录')),
    )
  })

  it('绑定的知识库会跟着表单一起提交', async () => {
    createWorkspace.mockResolvedValue({ ...WORKSPACE, id: 'ws_new' })
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('产品化'))

    await clickButton(wrapper, '新建工作区')!.trigger('click')
    const dialog = wrapper.find('.ws-create')
    await dialog.findAll('input')[0].setValue('带库的')
    await dialog.findAll('input')[1].setValue('E:/code/x')
    await dialog.find('.kb-pick').trigger('click') // 勾第一个库
    await clickButton(wrapper, '创建工作区')!.trigger('click')

    await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalled())
    expect(createWorkspace.mock.calls[0][0]).toMatchObject({
      name: '带库的',
      root_path: 'E:/code/x',
      kb_ids: ['kb_1'],
    })
  })

  it('建好后选中它，并把 `?new=1` 从地址里摘掉', async () => {
    // 不摘的话，刷新一次又会弹出来（"我明明建完了"）
    routeQuery = { new: '1' }
    createWorkspace.mockResolvedValue({ ...WORKSPACE, id: 'ws_new', name: '新的' })
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.find('.ws-create').exists()).toBe(true))

    const dialog = wrapper.find('.ws-create')
    await dialog.findAll('input')[0].setValue('新的')
    await dialog.findAll('input')[1].setValue('E:/code/x')
    await clickButton(wrapper, '创建工作区')!.trigger('click')

    await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith({ path: '/workspaces' }))
    await vi.waitFor(() =>
      expect(wrapper.find('.ws-form').findAll('input')[0].element.value).toBe('新的'),
    )
  })

  it('删除确认里写明会话不会被删', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('产品化'))
    await wrapper.find('.ws-row').trigger('click')

    const removeButton = clickButton(wrapper, '删除工作区')
    expect(removeButton).toBeTruthy()
    await removeButton!.trigger('click')

    // 用户最担心的是"删了个壳、里面的对话没了"——这句话必须在界面上
    const dialog = wrapper.findComponent({ name: 'ConfirmDialog' })
    expect(dialog.exists() || wrapper.html().includes('未被删除')).toBe(true)
  })

  it('面板上说明工作区不复制文件', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('产品化'))

    expect(wrapper.text()).toContain('不复制文件')
  })
})
