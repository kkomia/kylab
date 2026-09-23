/**
 * 设置弹窗（旧 `components/settings/SettingsModal.vue`）的用例。
 *
 * 这一节覆盖四件"迁移里最容易被简化掉"的事：
 * 1. **菜单按后端返回的组算**：没有专门一节的功能组会自动出现在「功能」下；
 * 2. **槽位绑定走 bindSlot**（不是改设置字段）——这正是 v0.8 归属整理那条；
 * 3. **测试连接失败要就地显示后端那句话**（不是一句"失败"）；
 * 4. **成员看不到「用户」分组**（写与管理端点是 `require_admin`）。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  testConnection: vi.fn(),
  getAuthStatus: vi.fn(async () => ({ needs_setup: false })),
  CHAT_MODE_KEY: 'chat.mode',
}))

vi.mock('@/api/modelRegistry', () => ({
  getRegistry: vi.fn(),
  bindSlot: vi.fn(),
  testSlot: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  registerModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
  testProvider: vi.fn(),
  listAvailableModels: vi.fn(async () => ({ models: [], count: 0 })),
  getAvailableModels: vi.fn(),
}))

vi.mock('@/api/health', () => ({
  fetchHealth: vi.fn(async () => ({
    status: 'ok',
    app: 'kylab',
    version: '0.43.0',
    api_version: 'v1',
  })),
}))

vi.mock('@/api/users', () => ({
  listUsers: vi.fn(async () => ({ items: [], header: 'X-Kylab-Operator' })),
  createUser: vi.fn(),
  resetUserPassword: vi.fn(),
  setUserDisabled: vi.fn(),
  deleteUser: vi.fn(),
}))

vi.mock('@/api/auth', () => ({
  changePassword: vi.fn(),
  logout: vi.fn(async () => undefined),
  uploadAvatar: vi.fn(),
  clearAvatar: vi.fn(),
  MIN_PASSWORD_CHARS: 8,
}))

vi.mock('@/api/maintenance', () => ({
  getStorageOverview: vi.fn(async () => ({ file_bytes: 1024, free_bytes: 0 })),
  compactStorage: vi.fn(),
}))

vi.mock('@/api/knowledgeBases', () => ({
  listKnowledgeBases: vi.fn(async () => ({ items: [] })),
}))

import { clearAvatar } from '@/api/auth'
import { bindSlot, getRegistry } from '@/api/modelRegistry'
import { getSettings, testConnection, type SettingsView } from '@/api/settings'
import { AvatarDialog } from '@/features/misc/settings/AvatarDialog'
import { SettingsModal } from '@/features/misc/settings/SettingsModal'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { resetAllShortcuts } from '@/features/misc/settings/useShortcuts'
import { useSessionStore } from '@/lib/session'

const getSettingsMock = vi.mocked(getSettings)
const getRegistryMock = vi.mocked(getRegistry)
const bindSlotMock = vi.mocked(bindSlot)
const testConnectionMock = vi.mocked(testConnection)

function settingsView(): SettingsView {
  return {
    groups: [
      {
        key: 'embedding',
        label: '向量化',
        fields: [
          {
            key: 'embedding.batch_size',
            label: '批大小',
            type: 'int',
            value: '16',
            configured: true,
            options: [],
          },
        ],
      },
      {
        key: 'llm',
        label: '对话模型',
        fields: [
          {
            key: 'llm.temperature',
            label: '温度',
            type: 'text',
            value: '0.7',
            configured: true,
            options: [],
          },
          {
            key: 'llm.enable_thinking',
            label: '深度思考',
            type: 'bool',
            value: 'true',
            configured: true,
            options: [],
          },
          {
            key: 'llm.thinking_effort',
            label: '思考强度',
            type: 'select',
            value: 'medium',
            configured: true,
            options: [
              { value: 'low', label: '低' },
              { value: 'medium', label: '中' },
            ],
          },
        ],
      },
      {
        key: 'chat',
        label: '对话行为',
        fields: [
          {
            key: 'chat.top_k',
            label: '带入资料条数',
            type: 'int',
            value: '8',
            configured: true,
            options: [],
          },
        ],
      },
      {
        // 后端新加的组：总设置里没有专门一节，必须**自动**出现在「功能」下
        key: 'misc_new',
        label: '实验特性',
        fields: [
          {
            key: 'misc_new.switch',
            label: '实验开关',
            type: 'bool',
            value: 'false',
            configured: true,
            options: [],
          },
        ],
      },
    ],
    embedding_model_id: 'BAAI/bge-m3',
    embedding_dim: 1024,
    embedding_configured: true,
    embedding_is_development: false,
    rerank_enabled: false,
  }
}

function registryView() {
  return {
    providers: [
      {
        id: 'p1',
        kind: 'llm',
        name: '深度求索',
        base_url: 'https://api.deepseek.com',
        enabled: true,
        created_at: null,
        updated_at: null,
        api_key_configured: true,
        api_key_hint: 'sk-xu…ten',
        model_count: 1,
      },
    ],
    models: [
      {
        id: 'm1',
        provider_id: 'p1',
        provider_name: '深度求索',
        provider_kind: 'llm',
        model_id: 'deepseek-chat',
        label: '对话主力',
        dim: null,
        capabilities: ['chat'],
        options: {},
        created_at: null,
        updated_at: null,
        bound_slots: ['chat'],
      },
      {
        id: 'm2',
        provider_id: 'p1',
        provider_name: '深度求索',
        provider_kind: 'llm',
        model_id: 'BAAI/bge-m3',
        label: '嵌入',
        dim: 1024,
        capabilities: ['embedding'],
        options: {},
        created_at: null,
        updated_at: null,
        bound_slots: ['embedding'],
      },
      {
        id: 'm3',
        provider_id: 'p1',
        provider_name: '深度求索',
        provider_kind: 'llm',
        model_id: 'BAAI/bge-large-zh',
        label: '嵌入（备选）',
        dim: 1024,
        capabilities: ['embedding'],
        options: {},
        created_at: null,
        updated_at: null,
        bound_slots: [],
      },
    ],
    slots: [
      {
        slot: 'embedding',
        label: '嵌入',
        capability: 'embedding',
        bound_model_pk: 'm2',
        bound_model_label: '嵌入',
        provider_name: '深度求索',
        configured: true,
        source: 'registry' as const,
      },
      {
        slot: 'chat',
        label: '对话',
        capability: 'chat',
        bound_model_pk: null,
        bound_model_label: '',
        provider_name: '',
        configured: false,
        source: 'none' as const,
      },
      {
        slot: 'rerank',
        label: '重排',
        capability: 'rerank',
        bound_model_pk: null,
        bound_model_label: '',
        provider_name: '',
        configured: false,
        source: 'none' as const,
      },
    ],
    provider_kinds: { llm: '对话 / 通用' },
    capabilities: { chat: '对话', embedding: '向量化', rerank: '重排' },
    provider_presets: [],
  }
}

function asAdmin(): void {
  useSessionStore.setState({
    token: 'st',
    currentUser: { id: 'u1', username: 'admin', name: '管理员', role: 'admin', avatar_url: '' },
    authStatus: null,
    reloginCount: 0,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  resetAllShortcuts()
  asAdmin()
  getSettingsMock.mockResolvedValue(settingsView())
  getRegistryMock.mockResolvedValue(registryView() as never)
  bindSlotMock.mockResolvedValue(registryView().slots[0] as never)
})

describe('设置弹窗', () => {
  it('默认落在模型注册，导航按后端返回的组自动出现「功能」一节', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)

    // 「模型注册」是打开时的落点：供应商与模型清单都在这一屏
    expect(await screen.findByText('深度求索')).toBeInTheDocument()
    expect(screen.getByText('sk-xu…ten')).toBeInTheDocument()

    // 后端新加的那一组**不需要有人回来改菜单**
    expect(await screen.findByText('实验特性')).toBeInTheDocument()
    // 已经搬走的组（memory / web / sandbox）不该在总设置里出现
    expect(screen.queryByText('长期记忆')).not.toBeInTheDocument()
  })

  it('内容区有页面级标题（左侧选中项的名字），灰字说明收进 ⓘ', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await screen.findByText('深度求索')

    // 「模型注册」这一节原先只有一行灰字可认路：标题缺位（评审 §设置-1）
    expect(screen.getByRole('heading', { name: '模型注册' })).toBeInTheDocument()
    // 那行灰字改成标题旁的问号（§5.1 的小字纪律）
    expect(screen.queryByText(/一个供应商 = 一个接口地址/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '说明' })).toBeInTheDocument()
  })

  it('模型行：没绑用途的写「未指定」，角色标记用中性标签（不再是绿色胶囊）', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await screen.findByText('深度求索')

    // m3 的 bound_slots 是空的——这一格不能留白
    expect(screen.getByText('未指定')).toBeInTheDocument()
    const role = screen.getByText('用于嵌入')
    expect(role).toHaveAttribute('data-variant', 'secondary')
  })

  it('绑定槽位走 bindSlot（不是改设置字段）', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: /向量化/ }))

    // 下拉已经是 @/ui/select（Radix 的 combobox + 浮层选项），不是原生 select
    const trigger = await screen.findByLabelText('默认嵌入模型')
    expect(trigger).toHaveAttribute('data-slot', 'select-trigger')
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('option', { name: /嵌入（备选）/ }))

    await waitFor(() => expect(bindSlotMock).toHaveBeenCalledWith('embedding', 'm3'))
    expect(await screen.findByText('默认模型已更新')).toBeInTheDocument()
  })

  it('测试连接失败态：就地显示后端那句 detail，而不是一句"失败"', async () => {
    testConnectionMock.mockResolvedValue({ ok: false, detail: '鉴权失败：401（key 无效）' })

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: /向量化/ }))
    // 「测试连接」在向量化这一屏有两颗（嵌入 / 重排），先测嵌入那一颗
    const [firstTest] = await screen.findAllByRole('button', { name: '测试连接' })
    await userEvent.click(firstTest)

    await waitFor(() => expect(testConnectionMock).toHaveBeenCalledWith('embedding'))
    expect(await screen.findByText('鉴权失败：401（key 无效）')).toBeInTheDocument()
  })

  it('成员看不到「用户」分组（写与管理端点是 require_admin）', async () => {
    useSessionStore.setState({
      token: 'st',
      currentUser: { id: 'u2', username: 'bob', name: '小王', role: 'member', avatar_url: '' },
      authStatus: null,
      reloginCount: 0,
    })

    renderMisc(<SettingsModal open onClose={() => undefined} />)

    await screen.findByText('深度求索')
    expect(screen.queryByRole('button', { name: /^用户$/ })).not.toBeInTheDocument()
    // 「外观」「快捷键」是本地偏好，成员照旧能改
    expect(screen.getByRole('button', { name: /外观/ })).toBeInTheDocument()
  })

  it('外观一节能切主题与字号（本地偏好，不进后端）', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: /外观/ }))

    await userEvent.click(await screen.findByRole('button', { name: /深色/ }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('kylab-theme')).toBe('dark')

    await userEvent.click(await screen.findByRole('button', { name: /更大/ }))
    expect(window.localStorage.getItem('kylab-font-scale')).toBe('xlarge')
  })

  it('系统与安全一节显示后端版本与鉴权状态', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: /系统与安全/ }))

    expect(await screen.findByText('在线 v0.43.0 · v1')).toBeInTheDocument()
    expect(screen.getByText(/已启用：\/api\/v1 一律需要登录会话或 API Key/)).toBeInTheDocument()
  })
})

describe('头像弹窗（账号菜单用它）', () => {
  it('显示当前头像，并给出「去掉头像」入口', () => {
    renderMisc(
      <AvatarDialog
        open
        name="管理员"
        url="https://example.com/avatar.png?sig=1"
        onClose={() => undefined}
      />,
    )

    expect(screen.getByLabelText('选择头像图片')).toBeInTheDocument()
    // 头像本体走 @/ui/avatar：拿不到图时由它自己的加载探测换成兜底（首字母）
    const avatar = document.querySelector('[data-slot="avatar"]')
    expect(avatar).toBeInTheDocument()
    expect(avatar?.querySelector('[data-slot="avatar-fallback"]')).toHaveTextContent('管')
    expect(screen.getByRole('button', { name: '去掉头像' })).toBeInTheDocument()
    // 没选图之前「保存」是灰的（不做无意义的上传）
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('去掉头像会写回会话状态（换完界面上要立刻变）', async () => {
    vi.mocked(clearAvatar).mockResolvedValue({
      id: 'u1',
      username: 'admin',
      name: '管理员',
      role: 'admin',
      avatar_url: '',
    })

    renderMisc(
      <AvatarDialog
        open
        name="管理员"
        url="https://example.com/avatar.png?sig=1"
        onClose={() => undefined}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: '去掉头像' }))

    await waitFor(() => expect(vi.mocked(clearAvatar)).toHaveBeenCalled())
    expect(await screen.findByText('已去掉头像')).toBeInTheDocument()
    expect(useSessionStore.getState().currentUser?.avatar_url).toBe('')
  })
})
