/**
 * 设置弹窗（旧 `components/settings/SettingsModal.vue`）的用例。
 *
 * 这一节覆盖四件"迁移里最容易被简化掉"的事：
 * 1. **菜单按后端返回的组算**：没有专门一节的功能组会自动出现在「功能」下；
 * 2. **槽位绑定走 bindSlot**（不是改设置字段）——这正是 v0.8 归属整理那条；
 * 3. **测试连接失败要就地显示后端那句话**（不是一句"失败"）；
 * 4. **账号那一节整块不在了**（2026-10-09）：原先这里还有「用户」分组与「系统与安全」
 *    里的改密 / 退出登录 / 访问鉴权——那些打的 `/auth/*`、`/users/*` 随账号死面下线。
 *
 * 文件末另有**账号菜单那一行**（侧栏左下）的用例：设置是模型 key 与知识库连接
 * 唯一的入口，而它的在不在由那一行判——所以它跟着这一份弹窗一起验（见末尾那一节）。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  testConnection: vi.fn(),
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

vi.mock('@/api/maintenance', () => ({
  getStorageOverview: vi.fn(async () => ({ file_bytes: 1024, free_bytes: 0 })),
  compactStorage: vi.fn(),
}))

vi.mock('@/api/knowledgeBases', () => ({
  listKnowledgeBases: vi.fn(async () => ({ items: [] })),
}))

import { fetchHealth } from '@/api/health'
import { bindSlot, getRegistry } from '@/api/modelRegistry'
import { getSettings, testConnection, type SettingsView } from '@/api/settings'
import { resetBackupStore, setBackupStatusForTest, type LocalBackup } from '@/api/backup'
import { resetLocalBackendForTest, setLocalBackendForTest } from '@/api/local'
import { resetProviderStore, setProviderStatusForTest } from '@/api/provider'
import { AccountMenu } from '@/features/layout/AccountMenu'
import { SettingsModal } from '@/features/misc/settings/SettingsModal'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { resetAllShortcuts } from '@/features/misc/settings/useShortcuts'

const getSettingsMock = vi.mocked(getSettings)
const getRegistryMock = vi.mocked(getRegistry)
const fetchHealthMock = vi.mocked(fetchHealth)
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

/** 把当前地址画出来：用来断言"点了那颗按钮真的跳到 `/backup`"（R5 那条唯一入口）。 */
function LocationProbe() {
  const location = useLocation()
  return <span data-testid="probe-path">{location.pathname}</span>
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  resetAllShortcuts()
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

  it('账号那一节整块不在了：没有「用户」分组，系统与安全里也没有改密 / 退出登录 / 访问鉴权', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)

    await screen.findByText('深度求索')
    // 「用户」那一节（名册 / 开通账号 / 重置密码）随账号死面一起删了
    expect(screen.queryByRole('button', { name: /^用户$/ })).toBeNull()
    // 「外观」「快捷键」是本地偏好，照旧在
    expect(screen.getByRole('button', { name: /外观/ })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /系统与安全/ }))
    expect(await screen.findByText('后端状态')).toBeInTheDocument()
    for (const gone of ['当前账号', '修改密码', '更新密码', '退出登录', '访问鉴权']) {
      expect(screen.queryByText(gone)).toBeNull()
    }
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

  it('系统与安全一节只说"后端在不在"：不写版本号、不写接口路径', async () => {
    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: /系统与安全/ }))

    // 状态点答"在不在"，值那一栏不再复述版本号（`在线 v0.43.0 · v1` 已删）
    expect(await screen.findByText('后端状态')).toBeInTheDocument()
    expect(screen.getByText('在线')).toBeInTheDocument()
    expect(screen.queryByText(/v0\.43\.0/)).toBeNull()
    expect(screen.queryByText(/\/api\/v1/)).toBeNull()
    // 那段解释 API Key 与登录会话是两条路的常显文字也删了（它带着 `app/api/auth.py`）
    expect(screen.queryByText(/API Key 不在这一页/)).toBeNull()
    expect(screen.queryByText(/app\/api\/auth\.py/)).toBeNull()
  })

  /*
   * 这个弹窗**一直挂在树上**（`AccountMenu` 那头"关掉"只是把 `open` 置回 false），
   * 所以那几条读要跟着 `open` 走：没有 `enabled` 就是每个页面加载都白读一趟 `/settings`
   * ——2026-10-05 之前正是如此，而 NAS 网页端退役之后那一档连这条端点都不服务
   * （404 会落在控制台里）。
   *
   * 用一颗按钮模拟真实的开合（`AccountMenu` 就是这么切的），因为这一条要验的正是
   * "`open` 从 false 变 true 时读不读"。
   */
  function Toggle({ initial = false }: { initial?: boolean }) {
    const [open, setOpen] = useState(initial)
    return (
      <>
        <SettingsModal open={open} onClose={() => undefined} />
        <button type="button" onClick={() => setOpen(true)}>
          打开设置
        </button>
      </>
    )
  }

  it('关着的时候三条读一条都不发：开一次才各读一趟（弹窗常挂，读了就是白读）', async () => {
    renderMisc(<Toggle />)

    // 关着：三条读（`/settings` / 模型注册 / `/health`）一条都不读
    // （挂上就各发一条是原先的行为）
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '打开设置' })).toBeInTheDocument(),
    )
    expect(getSettingsMock).not.toHaveBeenCalled()
    expect(getRegistryMock).not.toHaveBeenCalled()
    expect(fetchHealthMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: '打开设置' }))

    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1))
    // 打开之后照旧：这一屏的内容是从 `/settings` 来的
    expect(await screen.findByText('深度求索')).toBeInTheDocument()
    // 另外两条也**这才**读（关着的时候一条都不读）
    await waitFor(() => expect(getRegistryMock).toHaveBeenCalledTimes(1))
    expect(fetchHealthMock).toHaveBeenCalledTimes(1)
  })
})

/* ---------------- 头像弹窗（`AvatarDialog`）2026-10-09 整块删掉 ----------------
 *
 * 它挂在账号菜单的「头像」那一项上，而那一项打的是 `/auth/avatar`（服务器那一族）——
 * 账号死面清掉时，这一项、那个组件与它的两条用例一起去掉了（见 `AccountMenu.tsx`
 * 与 `api/auth.ts` 的文件头）。
 */

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

  it('知识库连接：状态 / 地址 / 凭据三行都在，库清单在，且**没有任何成句的解释**（R5）', async () => {
    setProviderStatusForTest(providerStatus())
    stubProviderNetwork(() => providerStatus())
    const user = userEvent.setup()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    // 「知识库连接」在「服务」那一组里
    await user.click(await screen.findByRole('button', { name: '知识库连接' }))

    // ① 状态一行：连没连上（值 + badge）+ 上次确认/协议版本的小字 + 一颗「测试连接」
    expect(screen.getAllByText('已连接').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument()
    expect(screen.getByText(/上次确认 · /)).toBeInTheDocument()
    // 协议版本降级成状态行里的小字（R5：技术味重的读数不单独占一行）
    expect(screen.getByText(/协议 v1/)).toBeInTheDocument()
    expect(screen.queryByText('协议版本')).toBeNull()
    // ② 地址：输入框里是后端解析后的实际地址，带保存与恢复默认
    expect(screen.getByLabelText('知识库地址')).toHaveValue('http://nas:8000/api/v1')
    expect(screen.getByRole('button', { name: '恢复默认' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled() // 没改过就不发请求
    // ③ 凭据：只读，且**只说有没有**（永不回显）
    expect(screen.getByText('已配置（桌面壳里的那把钥匙）')).toBeInTheDocument()
    // ④ 库清单：名字 / 文档数 / 能不能写
    expect(screen.getByText('论文')).toBeInTheDocument()
    expect(screen.getByText(/12 篇文档/)).toBeInTheDocument()
    expect(screen.getByText('可写')).toBeInTheDocument()
    expect(screen.getByText('手册')).toBeInTheDocument()
    expect(screen.getByText('只读')).toBeInTheDocument()

    /*
      **R5：这一节不再有成句的解释**（用户点名"解释太多了，你是一个产品好不好"）。
      判据落在 DOM 上：这一节里一个 `.m-row-note` / `.m-edit-hint` 都不该有——
      值、badge、按钮、以及"留空 = …"这类**填法**（在 label / placeholder 上）才是内容。
      那句"哪几个库参与检索，由对话里那个开关决定"的说明也随之下线。
    */
    // 这一节里一个 `.m-row-note` / `.m-edit-hint` 都不该有（R5：去解释化；这两个类是
    // "成句说明"在本仓的落点）。状态与值走的是 m-row-value / StatusTag / 按钮。
    expect(document.querySelectorAll('.m-row-note, .m-edit-hint').length).toBe(0)
    expect(screen.queryByText(/哪几个库参与检索/)).toBeNull()
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
    // （原因在状态那一行下方的 ErrorLine 上；库清单那一句只说"看不到任何库"，
    //  不再把同一句话复制一遍——R5 去解释化时顺手收掉的重复）
    await waitFor(() => expect(screen.getByText('连不上 other-nas')).toBeInTheDocument())
    expect(screen.getByText('连不上，所以现在看不到任何库。')).toBeInTheDocument()
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

/* ------------------- 「本机留了一份」那一块（M4 阶段 6） ------------------- */

describe('「本机留了一份」那一块（M4 阶段 6）', () => {
  /** 一份用量读数（形状照后端 `KbCacheStatsOut`）。 */
  function statsBody(rows: number, newest: string | null): Record<string, unknown> {
    return {
      rows,
      payload_bytes: 4096,
      oldest_fetched_at: newest,
      newest_fetched_at: newest,
    }
  }

  /** 一份"有内容"的快照（`revalidate` 的回话，形状照 `KbCacheSnapshotOut`）。 */
  function snapshotBody(): Record<string, unknown> {
    return {
      available: true,
      resource: 'kb_list',
      scope_key: '',
      reason: '',
      items: [{ id: 'kb_1', name: '论文' }],
      payload: { items: [{ id: 'kb_1', name: '论文' }] },
      version: 'sha256:abc',
      source: 'revalidate',
      fetched_at: '2026-10-01T09:00:00Z',
      checked_at: '2026-10-01T09:00:00Z',
      stale: false,
      last_error: '',
      revalidating: false,
    }
  }

  /** 六个字前看到的、12 项；清除之后变 0 项（数字当场跟着动）。 */
  const SIX_MINUTES_AGO = new Date(Date.now() - 6 * 60 * 1000).toISOString()

  function stubKeptNetwork(calls: string[]): void {
    let rows = 12
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const target = String(url)
        calls.push(`${init?.method ?? 'GET'} ${target}`)
        if (target.endsWith('/health')) return new Response(JSON.stringify({ ok: true }))
        if (target.includes('/local/kb-cache/revalidate')) {
          return new Response(JSON.stringify(snapshotBody()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (target.includes('/local/kb-cache/stats')) {
          return new Response(JSON.stringify(statsBody(rows, SIX_MINUTES_AGO)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (target.includes('/local/kb-cache') && init?.method === 'DELETE') {
          const removed = rows
          rows = 0
          return new Response(JSON.stringify({ removed }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify(providerStatus()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
  }

  beforeEach(() => {
    resetProviderStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetProviderStore()
  })

  it('四要素都在：留了几项 / 最近更新 / 「立即刷新」/「清除」（R5：那段说明已删）', async () => {
    setProviderStatusForTest(providerStatus())
    const calls: string[] = []
    stubKeptNetwork(calls)
    const user = userEvent.setup()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '知识库连接' }))

    const block = await screen.findByTestId('kept-snapshot-row')
    expect(block.textContent).toContain('留着的内容')
    expect(block.textContent).toContain('12 项')
    expect(block.textContent).toContain('最近更新')
    expect(block.textContent).toContain('6 分钟前')
    expect(screen.getByRole('button', { name: '立即刷新' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '清除' })).toBeInTheDocument()
    // 界面上**不许出现实现语汇**（"缓存"那一类，U2 是硬门禁）：说的是"留了一份"
    expect(block.textContent).not.toContain('缓存')
    // R5：原来那段"留着的是一份目录…删了只影响速度"的说明整段删掉（用户："解释太多了"）；
    // 那一块现在只有两行读数 + 两颗按钮
    expect(screen.queryByText(/删了只影响下次打开的速度/)).toBeNull()
    // 读的是后端那一份读数（不是前端自己数）
    expect(calls.some((call) => call.includes('/local/kb-cache/stats'))).toBe(true)
  })

  it('「立即刷新」：去 NAS 再确认一次（POST /revalidate 要库列表那一份），随后重读数字', async () => {
    setProviderStatusForTest(providerStatus())
    const calls: string[] = []
    stubKeptNetwork(calls)
    const user = userEvent.setup()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '知识库连接' }))
    await screen.findByTestId('kept-snapshot-row')
    await user.click(screen.getByRole('button', { name: '立即刷新' }))

    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')
    expect(String(post?.[0])).toContain('/local/kb-cache/revalidate')
    expect(JSON.parse(String(post?.[1]?.body)).resource).toBe('kb_list')
    expect(await screen.findByText('已去 NAS 确认一次')).toBeInTheDocument()
  })

  it('「清除」：DELETE 全清、清完数字当场归零（并说清清掉了几项）', async () => {
    setProviderStatusForTest(providerStatus())
    const calls: string[] = []
    stubKeptNetwork(calls)
    const user = userEvent.setup()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '知识库连接' }))
    await screen.findByTestId('kept-snapshot-row')
    await user.click(screen.getByRole('button', { name: '清除' }))

    const del = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(String(del?.[0])).toContain('/local/kb-cache')
    expect(await screen.findByText('已清掉 12 项')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('kept-snapshot-row').textContent).toContain('0 项'),
    )
  })

  it('读数读不到时如实写"读不到"（不静默摆一个 0）', async () => {
    setProviderStatusForTest(providerStatus())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const target = String(url)
        if (target.includes('/local/kb-cache')) {
          return new Response(JSON.stringify({ detail: 'boom' }), { status: 500 })
        }
        return new Response(JSON.stringify(providerStatus()), { status: 200 })
      }),
    )
    const user = userEvent.setup()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '知识库连接' }))

    const block = await screen.findByTestId('kept-snapshot-row')
    await waitFor(() => expect(block.textContent).toContain('读不到'))
    expect(block.textContent).toContain('还没有')
  })
})

/* ------------------- 「备份」与「凭据」两节（M5 阶段 7，本机档专属） ------------------- */

/**
 * 这两节与「知识库连接」同一处置：**本机档才有入口**，而入口的判据是"这一档有没有
 * 本机后端"（`api/backup.ts::backupGateApplies`），**不是**"备份提供者 ready"——
 * 远端连不上时正是要看"还有几份没备上去"的时候。
 */
describe('「备份」与「凭据」两节（M5 阶段 7）', () => {
  function backupPayload(overrides: Partial<LocalBackup> = {}): LocalBackup {
    return {
      provider: {
        state: 'ready',
        available: true,
        reason: '',
        checked_at: '2026-10-05T10:00:00Z',
        base_url: 'http://nas:8000',
        credential: 'configured',
        snapshot_available: true,
        snapshot_reason: '',
        protocol_version: 1,
        capabilities: { retention: { keep: 3 } },
        enabled: true,
        include_workspace: false,
        every_hours: 24,
      },
      backlog: {
        queued: 2,
        bytes: 4096,
        failed: 1,
        discarded: 1,
        oldest_created_at: null,
        last_error: '连不上远端',
      },
      snapshots: [],
      ...overrides,
    }
  }

  /** 备份那两条 + 凭据那两条的网络替身（按路径分派，PATCH 回一份新整包）。 */
  function stubBackupNetwork(options: { secrets?: unknown; secretsStatus?: number } = {}): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const target = String(url)
        const body = (payload: unknown, status = 200): Response =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { 'content-type': 'application/json' },
          })
        if (target.endsWith('/health')) return body({ ok: true })
        if (target.includes('/local/backup')) {
          return init?.method === 'PATCH'
            ? body(
                backupPayload({
                  provider: { ...backupPayload().provider, base_url: 'http://nas:9000' },
                }),
              )
            : body(backupPayload())
        }
        if (target.includes('/local/secrets/migrate')) {
          return body({ moved: 2, skipped: 0, failed: [] })
        }
        if (target.includes('/local/secrets')) {
          if (options.secretsStatus) return body({ message: 'nope' }, options.secretsStatus)
          return body(options.secrets ?? { store: 'available', pending_migration: 2 })
        }
        return body({})
      }),
    )
  }

  beforeEach(() => {
    resetBackupStore()
    resetProviderStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetBackupStore()
    resetProviderStore()
  })

  it('「备份」一节在「服务」那一组里，四项配置与队列摘要都在', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(backupPayload())
    stubBackupNetwork()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '备份' }))

    // 连接 + 队列（两半分开说）
    expect(screen.getByTestId('settings-backup-state').textContent).toContain('已连接')
    expect(screen.getByTestId('settings-backup-backlog').textContent).toContain('还有 2 份没备上去')
    expect(screen.getByTestId('settings-backup-backlog').textContent).toContain('一共丢过 1 份')
    // 凭据只读、不回显
    expect(screen.getByText('已配置（桌面壳里的那把钥匙）')).toBeInTheDocument()
    // 地址那一格是后端解析后的地址
    expect(screen.getByLabelText('备份地址')).toHaveValue('http://nas:8000')
    expect(screen.getByRole('button', { name: '恢复默认' })).toBeInTheDocument()
    // 三栏现在是**读回来的真值**（M5 收口 `f7eb285`）：开关回填当前态、输入框回填当前值
    const enabledRow = screen.getByTestId('settings-backup-enabled')
    expect(within(enabledRow).getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(within(enabledRow).getByText('打开')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('settings-backup-include-workspace')).getByRole('switch'),
    ).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText('每多少小时自动打一份')).toHaveValue('24')
    expect(screen.getByRole('button', { name: '保存间隔' })).toBeDisabled() // 没改过就不发
  })

  it('尾部那颗按钮是去 `/backup` 的入口，跳之前先把设置关掉（R5：它是唯一入口）', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(backupPayload())
    stubBackupNetwork()

    const onClose = vi.fn()
    renderMisc(
      <>
        <SettingsModal open onClose={onClose} />
        <LocationProbe />
      </>,
    )
    await user.click(await screen.findByRole('button', { name: '备份' }))
    await user.click(screen.getByRole('button', { name: /备份与恢复（明细与恢复点）/ }))

    // 侧栏那一组与顶栏那条状态条（连同它们的入口）都删了，所以这一条必须真的能跳
    expect(screen.getByTestId('probe-path').textContent).toBe('/backup')
    // 设置是浮层：跳走之前得先关掉它（否则新页面被它盖住）
    expect(onClose).toHaveBeenCalled()
  })

  it('改开关走 PATCH，只发那一个键（凭据类键一个都不带）', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(backupPayload())
    stubBackupNetwork()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '备份' }))
    await user.click(
      within(await screen.findByTestId('settings-backup-enabled')).getByRole('switch'),
    )

    await waitFor(() => {
      const patch = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(String(patch?.[0])).toContain('/local/backup')
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ enabled: false })
    })
  })

  it('三栏按后端给的值渲染（关 / 带上 / 12 小时）——这一节读的是同一份数据', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(
      backupPayload({
        provider: {
          ...backupPayload().provider,
          enabled: false,
          include_workspace: true,
          every_hours: 12,
        },
      }),
    )
    stubBackupNetwork()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '备份' }))

    const enabledRow = await screen.findByTestId('settings-backup-enabled')
    expect(within(enabledRow).getByText('关掉了')).toBeInTheDocument()
    expect(within(enabledRow).getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(
      within(screen.getByTestId('settings-backup-include-workspace')).getByText('带上'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('每多少小时自动打一份')).toHaveValue('12')
    // R5：原来那行"现在是每 12 小时自动打一份 / 填 0 = 只手动打"的说明删了——
    // 当前值就是输入框里的 `12`（上面那一条钉着），填法落在 placeholder 上
    expect(screen.getByLabelText('每多少小时自动打一份')).toHaveAttribute(
      'placeholder',
      '0 = 只手动打',
    )
    expect(screen.queryByText(/现在是每 12 小时自动打一份/)).toBeNull()
  })

  it('提供者连不上时这一节照旧在（判据不是 "ready"）', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(
      backupPayload({
        provider: {
          ...backupPayload().provider,
          state: 'unavailable',
          available: false,
          reason: '连不上那台 NAS',
        },
      }),
    )
    stubBackupNetwork()

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '备份' }))

    expect(await screen.findByText('连不上那台 NAS')).toBeInTheDocument()
    // 队列那半照旧
    expect(screen.getByTestId('settings-backup-backlog').textContent).toContain('还有 2 份没备上去')
  })

  it('「凭据」一节只说处数与钥匙串可用性，**不回声任何秘密**', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(backupPayload())
    stubBackupNetwork({ secrets: { store: 'available', pending_migration: 2 } })

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    const pending = await screen.findByTestId('secrets-pending')
    expect(pending.textContent).toContain('2 处明文凭据在库里')
    expect(pending.textContent).toContain('可以迁进系统钥匙串')
    expect(screen.getByTestId('secrets-store').textContent).toContain('可用')
    expect(screen.getByRole('button', { name: '迁进系统钥匙串' })).toBeEnabled()
  })

  it('点「迁进系统钥匙串」：POST 之后用报告里那个数当结论', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(backupPayload())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const target = String(url)
        const body = (payload: unknown, status = 200): Response =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { 'content-type': 'application/json' },
          })
        if (target.includes('/local/backup')) return body(backupPayload())
        if (target.includes('/local/secrets/migrate')) {
          // 报告的形状照 `SecretMigrationOut`（项里带的是"位置名"，界面只数个数）
          return body({
            store: 'available',
            migrated: [
              { item: 'setting:web.search_api_key', reason: '' },
              { item: 'model_provider:p1', reason: '' },
            ],
            skipped: [],
            failed: [],
            pending_migration: 0,
          })
        }
        return body({ store: 'available', pending_migration: 2 })
      }),
    )

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '凭据' }))
    await user.click(await screen.findByRole('button', { name: '迁进系统钥匙串' }))

    expect(await screen.findByText('已经迁了 2 处，都收好了')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('secrets-pending').textContent).toContain('都收好了'),
    )
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    // **项名不上屏幕**（那是本机库里的键名，不是给用户看的东西）
    expect(screen.queryByText(/web\.search_api_key/)).toBeNull()
  })

  it('有失败项：如实报数，并说清明文还在库里（可以再点一次）', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(backupPayload())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const target = String(url)
        const body = (payload: unknown, status = 200): Response =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { 'content-type': 'application/json' },
          })
        if (target.includes('/local/backup')) return body(backupPayload())
        if (target.includes('/local/secrets/migrate')) {
          return body({
            store: 'available',
            migrated: [{ item: 'setting:a', reason: '' }],
            skipped: [],
            failed: [{ item: 'model_provider:p1', reason: '写不进去' }],
            pending_migration: 1,
          })
        }
        return body({ store: 'available', pending_migration: 2 })
      }),
    )

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '凭据' }))
    await user.click(await screen.findByRole('button', { name: '迁进系统钥匙串' }))

    expect(
      await screen.findByText('迁了 1 处，还有 1 处没迁成（明文还在库里，可以再点一次）'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('secrets-pending').textContent).toContain('1 处明文凭据在库里')
  })

  it('这一版没有那两个端点（404）：如实说"这一版还没有这一项"（不显示成 0 处）', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(backupPayload())
    stubBackupNetwork({ secretsStatus: 404 })

    renderMisc(<SettingsModal open onClose={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    expect(await screen.findByTestId('secrets-unsupported')).toHaveTextContent('这一版还没有这一项')
    expect(screen.queryByTestId('secrets-pending')).toBeNull()
  })

  it('服务器档（这一档没有本机后端）：两节的入口都**不存在**', async () => {
    setBackupStatusForTest(null, { unsupported: true })

    renderMisc(<SettingsModal open onClose={() => undefined} />)

    expect(await screen.findByRole('button', { name: '服务配置' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '备份' })).toBeNull()
    expect(screen.queryByRole('button', { name: '凭据' })).toBeNull()
  })
})

/* ------------------- 账号菜单那一行（侧栏左下；2026-10-05 修的那条 bug） ------------------- */

/**
 * 这一行是**设置唯一的入口**（模型 key 与知识库连接都在弹窗里），所以它按什么判"我在不在"
 * 直接等于"进不进得去设置"。
 *
 * 这一份界面没有账号体系（登录页与 `/auth/*` 一族都删了，会话状态里的 `currentUser`
 * 也随名册 / 操作者链一起删掉）：后端把这一档短路成「本机主人」
 * （`backend/app/api/auth.py::current_caller`），而**本机主人就是这台机器的管理员**
 * （`lib/useIsAdmin`，判据如今就是"有没有本机后端"）。原先两处都按"有没有登录"判，于是
 * 名字留白、菜单里也没有「设置」——用户看到的就是「现在怎么左下角设置这些都没了？？」。
 *
 * 两档各摆一次答案（判据是 `api/local.ts::localBackendView`，用 `setLocalBackendForTest`
 * 直接摆好，不经过网络）：本机档（有本机后端）/ 服务器档（没有）。
 */
describe('账号菜单那一行（侧栏左下）', () => {
  afterEach(() => {
    // 模块级单份状态必须由调用方复位，否则前一条用例的结论会串到下一条
    resetLocalBackendForTest()
  })

  it('本机档：写着「本机主人」，菜单里有「设置」，点它能打开弹窗', async () => {
    setLocalBackendForTest('local')

    renderMisc(<AccountMenu />)

    // 名字照后端那个唯一主体的口径（`AccountMenu.tsx::LOCAL_CALLER_NAME`）
    expect(screen.getByText('本机主人')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '账号：本机主人' })).toBeInTheDocument()
    // 角色徽章照旧不给：没有账号就没有角色（本机主人不是"管理员"这个角色）
    expect(screen.queryByText('管理员')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '账号：本机主人' }))
    const menu = await screen.findByRole('menu')
    // 「头像」「退出登录」都不在了（2026-10-09 随账号死面删掉，见文件头那一段）
    expect(within(menu).queryByRole('menuitem', { name: '头像' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: '退出登录' })).toBeNull()
    await userEvent.click(within(menu).getByRole('menuitem', { name: '设置' }))

    // 真的开起来了（落点是「模型注册」那一屏，与别的用例同一处认路）
    expect(await screen.findByRole('heading', { name: '模型注册' })).toBeInTheDocument()
    expect(getSettingsMock).toHaveBeenCalledTimes(1)
  })

  it('服务器档（没有本机后端）：没有「设置」，主题那一项照旧', async () => {
    setLocalBackendForTest('absent')

    renderMisc(<AccountMenu />)

    // 那一档"没有登录"就是没有身份：留白是实话，写个名字只会让人以为登录被吞了
    expect(screen.getByRole('button', { name: '账号' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '账号' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByRole('menuitem', { name: '设置' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: '头像' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: '退出登录' })).toBeNull()
    // 主题翻转与本机后端无关，照旧在（菜单里不能只剩个空壳）
    expect(within(menu).getByRole('menuitem', { name: /切换为/ })).toBeInTheDocument()
    // 入口不在，弹窗也没挂：那几条读一条都不发（两者同一条件）
    expect(getSettingsMock).not.toHaveBeenCalled()
    expect(getRegistryMock).not.toHaveBeenCalled()
  })

  it('回归：本机档（本机主人就是这台机器的管理员）——「设置」照旧在（与旧行为一致）', async () => {
    setLocalBackendForTest('local')

    renderMisc(<AccountMenu />)

    await userEvent.click(screen.getByRole('button', { name: '账号：本机主人' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: '设置' })).toBeInTheDocument()
    // 主题那一项的名字看当前生效的档（同文件里别的用例翻过主题，模块级状态是留着的）
    expect(within(menu).getByRole('menuitem', { name: /切换为/ })).toBeInTheDocument()
  })
})
