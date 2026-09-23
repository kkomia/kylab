/**
 * 模型注册器（旧 `components/settings/ModelRegistryPanel.vue`）的用例。
 *
 * 四条与密钥纪律、归属整理直接相关的口径：
 * 1. **只显示掩码**，不回显密钥；编辑时那一栏留空（留空 = 不改）；
 * 2. **模型行上仍显示「用于向量化」**（只读状态：删它之前要知道会影响什么）；
 * 3. **预设只填表单、不落库**：地址与名称以表单里的为准；
 * 4. **加模型的候选来自上游探测 + 预设建议**，探测失败要给"可手写"的出路。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/modelRegistry', () => ({
  getRegistry: vi.fn(),
  listAvailableModels: vi.fn(async () => ({ models: [], count: 0 })),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  registerModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
  testProvider: vi.fn(),
  bindSlot: vi.fn(),
  testSlot: vi.fn(),
}))

import {
  createProvider,
  deleteModel,
  getRegistry,
  listAvailableModels,
  registerModel,
  testProvider,
} from '@/api/modelRegistry'
import { ModelRegistryPanel } from '@/features/misc/settings/ModelRegistryPanel'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'

const getRegistryMock = vi.mocked(getRegistry)
const createProviderMock = vi.mocked(createProvider)
const registerModelMock = vi.mocked(registerModel)
const listAvailableMock = vi.mocked(listAvailableModels)
const testProviderMock = vi.mocked(testProvider)
const deleteModelMock = vi.mocked(deleteModel)

function registry() {
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
    ],
    slots: [
      {
        slot: 'chat',
        label: '对话',
        capability: 'chat',
        bound_model_pk: 'm1',
        bound_model_label: '对话主力',
        provider_name: '深度求索',
        configured: true,
        source: 'registry' as const,
      },
    ],
    provider_kinds: { llm: '对话 / 通用' },
    capabilities: { chat: '对话', embedding: '向量化' },
    provider_presets: [
      {
        id: 'deepseek',
        label: '深度求索',
        kind: 'llm',
        base_url: 'https://api.deepseek.com',
        hint: '在开放平台 → API Keys 里拿一把',
        models: [
          { model_id: 'deepseek-chat', label: '对话主力', capabilities: ['chat'], dim: null },
        ],
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  getRegistryMock.mockResolvedValue(registry() as never)
  listAvailableMock.mockResolvedValue({ models: [], count: 0 })
  createProviderMock.mockResolvedValue(registry().providers[0] as never)
})

describe('模型注册器', () => {
  it('供应商卡片显示类别、掩码与模型数，模型行标出「用于对话」', async () => {
    renderMisc(<ModelRegistryPanel />)

    expect(await screen.findByText('深度求索')).toBeInTheDocument()
    expect(screen.getByText('sk-xu…ten')).toBeInTheDocument()
    expect(screen.getByText('1 个模型')).toBeInTheDocument()
    // 删模型之前要知道会影响什么：这一行是**只读状态**
    expect(screen.getByText('用于对话')).toBeInTheDocument()
  })

  it('选预设只填表单，提交时把预设填好的名称与地址一起发出去', async () => {
    renderMisc(<ModelRegistryPanel />)
    await userEvent.click(await screen.findByRole('button', { name: '添加供应商' }))

    await userEvent.selectOptions(screen.getByLabelText('供应商预设'), 'deepseek')

    expect(screen.getByLabelText('名称')).toHaveValue('深度求索')
    expect(screen.getByLabelText('接口地址')).toHaveValue('https://api.deepseek.com')
    expect(screen.getByText('在开放平台 → API Keys 里拿一把')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() =>
      expect(createProviderMock).toHaveBeenCalledWith({
        kind: 'llm',
        name: '深度求索',
        base_url: 'https://api.deepseek.com',
        api_key: '',
      }),
    )
  })

  it('加模型：上游探测失败也能手写，并带上勾选的能力', async () => {
    listAvailableMock.mockRejectedValueOnce(new Error('连接超时'))
    registerModelMock.mockResolvedValue(registry().models[0] as never)

    renderMisc(<ModelRegistryPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /深度求索 的操作/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '添加模型' }))

    // 探测失败不弹错误通知，只就地给一句提示，并指明手写这条出路
    expect(
      await screen.findByText(/拉取候选失败：连接超时。可直接输入模型 ID。/),
    ).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('模型 ID'), 'BAAI/bge-m3')
    await userEvent.click(screen.getByRole('checkbox', { name: '向量化' }))
    await userEvent.click(screen.getByRole('button', { name: '登记' }))

    await waitFor(() =>
      expect(registerModelMock).toHaveBeenCalledWith({
        provider_id: 'p1',
        model_id: 'BAAI/bge-m3',
        label: '',
        dim: null,
        capabilities: ['embedding'],
      }),
    )
  })

  it('测试连接失败：把供应商探活的结论原样报出来', async () => {
    testProviderMock.mockRejectedValueOnce(new Error('域名解析失败'))

    renderMisc(<ModelRegistryPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /深度求索 的操作/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /测试连接/ }))

    expect(await screen.findByText('域名解析失败')).toBeInTheDocument()
  })

  it('删除模型前说清"它正被几个用途使用"（删除会自动解绑）', async () => {
    deleteModelMock.mockResolvedValue(undefined)

    renderMisc(<ModelRegistryPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /对话主力 的操作/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '删除' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('删除模型「对话主力」？')).toBeInTheDocument()
    expect(within(dialog).getByText(/它正被 1 个用途使用，删除后会自动解绑。/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }))

    await waitFor(() => expect(deleteModelMock).toHaveBeenCalledWith('m1'))
  })
})
