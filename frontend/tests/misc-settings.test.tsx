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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  testConnection: vi.fn(),
  getAuthStatus: vi.fn(async () => ({ needs_setup: false })),
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
import { resetProviderStore, setProviderStatusForTest } from '@/api/provider'
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

  it('内容区有页面级标题（左侧选中项的名字），"供应商是什么"的说明已删干净', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await screen.findByText('深度求索')

    // 「模型注册」这一节原先只有一行灰字可认路：标题缺位（评审 §设置-1）
    expect(screen.getByRole('heading', { name: '模型注册' })).toBeInTheDocument()
    // 那行灰字后来收进标题旁的 ⓘ，2026-09-24 按用户要求**连 ⓘ 一起删掉**：
    // "一个供应商 = 一个接口地址 + 一把凭据"是在解释它是什么，不是填这一格要的信息
    expect(screen.queryByText(/一个供应商 = 一个接口地址/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '说明' })).not.toBeInTheDocument()
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

  it('系统与安全一节只说"在不在"与"要不要登录"：不写版本号、不写接口路径', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: /系统与安全/ }))

    // 状态点答"在不在"，值那一栏不再复述版本号（`在线 v0.43.0 · v1` 已删）
    expect(await screen.findByText('后端状态')).toBeInTheDocument()
    expect(screen.getByText('在线')).toBeInTheDocument()
    expect(screen.queryByText(/v0\.43\.0/)).toBeNull()
    // 鉴权那行同样不写 `/api/v1`：已启用就是已启用
    expect(screen.getByText('访问鉴权')).toBeInTheDocument()
    expect(screen.getByText('已启用')).toBeInTheDocument()
    expect(screen.queryByText(/\/api\/v1/)).toBeNull()
    // 那段解释 API Key 与登录会话是两条路的常显文字也删了（它带着 `app/api/auth.py`）
    expect(screen.queryByText(/API Key 不在这一页/)).toBeNull()
    expect(screen.queryByText(/app\/api\/auth\.py/)).toBeNull()
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

/* ------------------- 「知识库连接」一节（M3 阶段 6，本机档专属） ------------------- */

/** 一份 ready 的提供者状态（形状照 `ProviderStatusOut` / `ProviderStatus.to_payload()`）。 */
function providerStatus(
  overrides: Partial<import('@/api/provider').ProviderStatus> = {},
): import('@/api/provider').ProviderStatus {
  return {
    state: 'ready',
    available: true,
    reason: '',
    checked_at: '2026-10-03T10:00:00Z',
    base_url: 'http://nas:8000/api/v1',
    credential: 'configured',
    protocol_version: 1,
    app_version: '0.1.1',
    capabilities: {
      ingest: { max_bytes: 200 * 1024 * 1024, extensions: ['pdf', 'docx'] },
      embedding: { configured: true },
    },
    caller: { kind: 'api_key', is_admin: false, can_write: true },
    knowledge_bases: [
      { id: 'kb_1', name: '论文', document_count: 12, can_write: true, wiki_enabled: false },
      { id: 'kb_2', name: '手册', document_count: 3, can_write: false, wiki_enabled: true },
    ],
    ...overrides,
  }
}

/** 网络替身：`/health` 一律 200（壳里那台活着），提供者那两条按预备的回答。 */
function stubProviderNetwork(answerFor: () => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url)
      if (target.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const body = init?.method === 'PATCH' ? answerFor() : providerStatus()
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

describe('知识库连接一节（M3 阶段 6）', () => {
  beforeEach(() => {
    resetProviderStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetProviderStore()
  })

  it('四块内容都在：地址 / 凭据 / 状态 / 库清单，外加"哪几个库参与检索"那句说明', async () => {
    setProviderStatusForTest(providerStatus())
    stubProviderNetwork(() => providerStatus())
    const user = userEvent.setup()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    // 「知识库连接」在「服务」那一组里
    await user.click(await screen.findByRole('button', { name: '知识库连接' }))

    // ① 地址：输入框里是后端解析后的实际地址，带保存与恢复默认
    expect(screen.getByLabelText('知识库地址')).toHaveValue('http://nas:8000/api/v1')
    expect(screen.getByRole('button', { name: '恢复默认' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled() // 没改过就不发请求
    // ② 凭据：只读，且**只说有没有**（永不回显）
    expect(screen.getByText('已配置（桌面壳里的那把钥匙）')).toBeInTheDocument()
    // ③ 状态：人话 + 协议版本 + 上次确认 + 一颗「测试连接」
    expect(screen.getAllByText('已连接').length).toBeGreaterThan(0)
    expect(screen.getByText('协议版本')).toBeInTheDocument()
    expect(screen.getByText('1（对面应用 0.1.1）')).toBeInTheDocument()
    expect(screen.getByText('上次确认')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument()
    // ④ 库清单：名字 / 文档数 / 能不能写
    expect(screen.getByText('论文')).toBeInTheDocument()
    expect(screen.getByText(/12 篇文档/)).toBeInTheDocument()
    expect(screen.getByText('可写')).toBeInTheDocument()
    expect(screen.getByText('手册')).toBeInTheDocument()
    expect(screen.getByText('只读')).toBeInTheDocument()
    // 那句"避免再发明一个默认库集"的说明
    expect(screen.getByText(/哪几个库参与检索/)).toBeInTheDocument()
  })

  it('保存地址走 PATCH，并把新地址显示出来（后端会立刻重探并回最新状态）', async () => {
    setProviderStatusForTest(providerStatus())
    stubProviderNetwork(() =>
      providerStatus({
        base_url: 'http://other-nas:8000/api/v1',
        state: 'unavailable',
        available: false,
        reason: '连不上 other-nas',
      }),
    )
    const user = userEvent.setup()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '知识库连接' }))

    const input = screen.getByLabelText('知识库地址')
    await user.clear(input)
    await user.type(input, 'http://other-nas:8000/api/v1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    const patch = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(String(patch?.[0])).toContain('/local/provider')
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      base_url: 'http://other-nas:8000/api/v1',
    })
    // 回来的状态整个写进面板：地址变了，状态也如实变成"不可用 + 原因"
    await waitFor(() => expect(screen.getByText('连不上 other-nas')).toBeInTheDocument())
    expect(screen.getByLabelText('知识库地址')).toHaveValue('http://other-nas:8000/api/v1')
  })

  it('「恢复默认」用空串发（空 = 清掉覆盖、回继承壳里那台）', async () => {
    setProviderStatusForTest(providerStatus({ base_url: 'http://other-nas:8000/api/v1' }))
    stubProviderNetwork(() => providerStatus({ base_url: 'http://nas:8000/api/v1' }))
    const user = userEvent.setup()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '知识库连接' }))
    await user.click(screen.getByRole('button', { name: '恢复默认' }))

    const patch = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ base_url: '' })
  })

  it('连不上时显示原因，而不是一个空清单（"看不见库"与"根本没连上"是两件事）', async () => {
    setProviderStatusForTest(
      providerStatus({
        state: 'unavailable',
        available: false,
        reason: '知识库提供者拒绝了这把凭据（HTTP 401）',
        protocol_version: null,
        knowledge_bases: [],
      }),
    )
    stubProviderNetwork(() => providerStatus())

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: '知识库连接' }))

    // 原因出现在"状态"那一行与"看得见的库"那一句里（两处都如实说，不摆空清单）
    expect(
      (await screen.findAllByText(/知识库提供者拒绝了这把凭据（HTTP 401）/)).length,
    ).toBeGreaterThan(0)
    // 协议版本那几行**根本没有**（不 ready 时它们不在响应里，界面也不该摆空行）
    expect(screen.queryByText('协议版本')).toBeNull()
  })

  it('浏览器 / NAS 网页端（这一档没有 /local/provider）：**没有这一节**', async () => {
    setProviderStatusForTest(null, { unsupported: true })

    renderMisc(<SettingsModal open onClose={() => undefined} />)

    // 其余几节照旧（服务配置在），而知识库连接不在
    expect(await screen.findByRole('button', { name: '服务配置' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '知识库连接' })).toBeNull()
  })
})
