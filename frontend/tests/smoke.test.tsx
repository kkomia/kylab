/**
 * 应用壳的冒烟用例（P2 起升级成真用例：P0 那句占位断言已经被 ChatPage 替换掉了）。
 *
 * 钉住三件事：路由挂得上、**本机后端门禁**的两条分支、全局容器（Toaster）在。
 *
 * 门禁的判据只有一处（`@/api/local.ts::localBackendPresent`），这一份里**直接摆结论**
 * （`setLocalBackendForTest`），所以启动时不发任何探测请求——原先那两件"守卫要的网络事"
 * （引导状态、会话恢复）随登录页一起下线了（本机档免登录，见 `app/App.tsx` 的文件头）。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '@/app/App'
import { resetBackupStore } from '@/api/backup'
import { resetLocalBackendForTest, setLocalBackendForTest } from '@/api/local'

/**
 * 「能力」那一页**永远不落地**（`PAGES.capabilities` 换成一个永不 resolve 的 promise）。
 *
 * 只为「启动期的骨架」那一条：真实的懒加载只有 20–62ms，`render()` 返回时 chunk
 * 早就到位了，那一帧根本读不到。**挑的正是这一份里唯一没人渲染的那一页**，
 * 所以其余用例（壳、对话页、备份页）一个字都不受影响。
 */
vi.mock('@/app/routes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/routes')>()
  return {
    ...actual,
    PAGES: { ...actual.PAGES, capabilities: () => new Promise(() => undefined) as never },
  }
})

// 对话页那一堆读接口：冒烟只关心"路由到了它"，网络一律空答复
vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    chatStream: vi.fn(),
    openLiveTurn: vi.fn(async () => ({ abort: vi.fn() })),
    listCommands: vi.fn(async () => []),
    getContextUsage: vi.fn(async () => ({ items: [], used: 0, total: 0 })),
    getSuggestedQuestions: vi.fn(async () => ({ questions: [], generated: false })),
  }
})

vi.mock('@/api/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/conversations')>()
  return {
    ...actual,
    // 一条空会话（形状按契约给全）：冒烟只关心"路由到了对话页"，不推任何事件
    getConversation: vi.fn(async () => ({
      id: 'c1',
      title: '冒烟',
      kb_ids: [],
      model_pk: '',
      thinking: null,
      thinking_effort: null,
      workspace_id: null,
      pinned: false,
      archived: false,
      message_count: 0,
      created_at: null,
      updated_at: null,
      messages: [],
    })),
    listConversations: vi.fn(async () => ({ items: [], total: 0 })),
    listArtifacts: vi.fn(async () => ({ items: [] })),
    listFiles: vi.fn(async () => ({
      mode: 'object',
      label: '本会话',
      path: '',
      parent: null,
      entries: [],
      truncated: false,
    })),
  }
})

vi.mock('@/api/knowledgeBases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/knowledgeBases')>()
  return { ...actual, listKnowledgeBases: vi.fn(async () => ({ items: [], total: 0 })) }
})

vi.mock('@/api/modelRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/modelRegistry')>()
  return { ...actual, getRegistry: vi.fn(async () => ({ providers: [], models: [], slots: [] })) }
})

// 壳（侧栏）一挂载就要这三样：会话清单、项目清单、名册
vi.mock('@/api/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/workspaces')>()
  return { ...actual, listWorkspaces: vi.fn(async () => ({ items: [] })) }
})

describe('应用壳', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/')
    resetLocalBackendForTest()
  })

  // **门禁只认"有没有本机后端"**（2026-10-08）：本机档（边车在跑）直接进壳，
  // 一个字都不问——不问登录、也不问远端账号体系。所以这一条里**一个凭据都没有**。
  it('本机档：没有凭据也放行，不问登录', { timeout: 30_000 }, async () => {
    setLocalBackendForTest('local')

    /*
     * **先把对话页那一大包拉下来，再测重定向**（这一条为什么曾经被拖红，见下）。
     *
     * `/` 是一条重定向（2026-10-09 起），而标题由 `TitleSync` 在**提交之后**才写；
     * "从 `/` 跳到 `/chat`"这一次更新会因为对话页在懒加载（assistant-ui 那一大包）
     * 而**被 React 挂起**——挂起的更新不提交，标题就一直是旧值（实测：几个量测点上
     * 它都只在 chunk 落地那一刻才变）。于是原先那条"对着 `document.title` 轮询 12s"
     * 实质是在等 chunk：全量 65 worker 并发下实测 7–14s，撞线的正是它。
     *
     * 预热之后 chunk 进了模块缓存，重定向这一步**不再挂起**：地址同步变、标题下一拍就变
     * ——等的是**条件**，不是墙钟。预热这一趟本身也写成条件等待（"对话页真的渲染出来了"），
     * 30s 只当天花板（实测满载 7–14s）。真对话页的渲染由同文件的
     * `/chat` 那条与 `tests/chat-ui.test.tsx` 覆盖，这一条只管门禁与重定向。
     */
    window.history.pushState({}, '', '/chat')
    const warm = render(<App />)
    await screen.findByLabelText('对话内容', undefined, { timeout: 30_000 })
    warm.unmount()

    window.history.pushState({}, '', '/')
    render(<App />)

    // 地址这一步是同步完成的（`<Navigate>` 在 effect 里改 history），标题随后一拍
    await waitFor(() => expect(window.location.pathname).toBe('/chat'))
    await waitFor(() => expect(document.title).toBe('对话 · KYLAB'))
    expect(screen.queryByText('本机后端未启动')).toBeNull()
  })

  // 反向验证的**确定性守卫**：这一条要等整壳（懒加载的对话页 chunk + Provider 挂载链）才
  // settle，属"CPU 型重活"——全量并发时超过默认 5s（实测 5120ms），而**单跑**只有 ~2.4s、
  // 撤掉超时照样绿，所以"单跑拿红"抓不到这个失效。用源码断言钉住：删了就红。
  it('重挂载类用例带着显式超时（删了就红）', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    expect(source).toMatch(
      /it\(\s*'`\/chat` 落在对话页（壳的内容区里）'\s*,\s*\{\s*timeout:\s*15_000\s*\}/,
    )
    // **内层那一处也要显式放宽**：它等的正是懒加载 chunk + Provider 挂载链。
    // 原先 5s，满载实测这条用例 7014ms ✗（> 内层 5s ⇒ 是**它**先超时）→ 提到 12s。
    // 把这一处改回默认（或调小）就红——不依赖负载，单跑也能抓到。
    expect(source).toMatch(/getByLabelText\('对话内容'\)[\s\S]{0,120}?timeout:\s*1[0-9]_000/)
  })

  // **放宽这一处**（不是放宽全局 `testTimeout`）：要等懒加载 chunk + Provider 挂载链，
  // CPU 型重活，全量并发时被挤过默认 5s（实测 5120ms → 那次放宽到 5s；后来又实测
  // **7014ms ✗**（全量 1084 条）→ 内层这一处再抬到 12s）。外层 15s 是兜底，不动。
  it('`/chat` 落在对话页（壳的内容区里）', { timeout: 15_000 }, async () => {
    window.history.pushState({}, '', '/chat')
    render(<App />)

    // 对话页是**懒加载**的（chunk 里有 assistant-ui + katex + highlight，静态 import 会把
    // 主 chunk 顶到 1.4 MB）：这里要等一次动态 import + 整壳 Provider 挂载，
    // 满载并发下实测到 7s ✗ —— 只放宽**这一处内层等待**，别用默认的 1 秒、也别动全局。
    await waitFor(
      () => {
        expect(screen.getByLabelText('对话内容')).toBeInTheDocument()
      },
      { timeout: 12_000, interval: 50 },
    )
  })

  it('没有本机后端：换成一页「本机后端未启动」，不是登录页', async () => {
    setLocalBackendForTest('absent')
    window.history.pushState({}, '', '/')

    render(<App />)

    expect(await screen.findByText('本机后端未启动')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull()
  })

  /**
   * `/backup` 那条路由挂上了（M5 阶段 7）。
   *
   * 这一档（浏览器里、没有桌面壳）**不是本机档**，所以看到的是守卫那句说明——
   * 这一条同时在验两件事：路由指向的是 `BackupRoute`+`BackupPage`（不是 404 页），
   * 以及"不是本机档"那一条分支说得清楚。本机档那一支（提供者连不上也放行）
   * 在 `tests/backup-gate.test.tsx` 里逐条钉着。
   *
   * 门禁那一道**先摆成"有本机后端"**：`/backup` 是壳里的一页，没有本机后端时
   * 整壳都不渲染（门禁换成一页提示，见 `tests/local-backend-gate.test.tsx`）。
   */
  it('`/backup` 落在备份页（本机档专属那一页挂上了路由）', { timeout: 15_000 }, async () => {
    // **这一条只看路由挂没挂上**，与"这台机器上有没有边车在跑"无关：开发机上真有一套
    // 边车时（`.tmp/m5-evidence/` 那种真机物证），`/backup` 是"本机档"、页面会照常渲染，
    // 那句"只有本机档才有"就不会出现——所以这里把门禁与提供者状态都摆稳
    // （跑起来不会因为旁边有没有边车而红）。
    setLocalBackendForTest('local')
    resetBackupStore()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('这一条用例不发真请求')
      }),
    )
    window.history.pushState({}, '', '/backup')
    render(<App />)

    await waitFor(
      () => {
        expect(screen.getByText(/「备份」只有本机档/)).toBeInTheDocument()
      },
      { timeout: 12_000, interval: 50 },
    )
    vi.unstubAllGlobals()
  })
})

/**
 * 启动期那一帧（D30，2026-09-28 走查）。
 *
 * 走查那会儿这里是"探身份期间（146–513ms）的纯空白"，骨架是为那一段加的。
 * 2026-10-08 起门禁**不再探身份**（本机档免登录，判据是同步的），所以那一段没有了——
 * 骨架如今只剩一个用途：**路由懒加载那一段**的兜底，这一条钉的就是它。
 *
 * **首页那一页在这里被按成"永远不落地"**（见本文件顶部那个 `@/app/routes` 替身）：
 * 真实的懒加载只有 20–62ms，`render()` 返回时 chunk 早就到位了（实测过，
 * `getByTestId` 直接报 not found）——不挂住它，这一帧根本读不到。
 */
describe('启动期的骨架（D30）', () => {
  it('懒加载那一帧显示骨架，而不是一块白画布', () => {
    setLocalBackendForTest('local')
    window.history.pushState({}, '', '/capabilities')

    render(<App />)

    // **同步读**（不能 await）：「能力」那一页在本文件里被按成永不落地，
    // 所以 `Suspense` 的兜底就停在这一帧上。
    const skeleton = screen.getByTestId('app-boot-skeleton')
    // 形状照着应用壳摆（侧栏一栏 + 内容块），不是一块什么都没有的画布
    expect(skeleton.querySelectorAll('span').length).toBeGreaterThan(3)
  })
})
