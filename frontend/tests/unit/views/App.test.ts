/**
 * 应用外壳的一处行为（v0.26，用户报的 bug）。
 *
 * 原话是"查看了历史对话页面之后，点击其他菜单均没有任何反应，无法切换"。
 * 根因不在菜单上：历史面板是**一块盖住内容区的浮层**
 * （`inset: 0 0 0 var(--sidebar-width)`，侧栏故意留在它左边，好让人一边翻历史一边切页），
 * 而它不随路由关闭——点「笔记」路由确实变了，可内容区上还压着历史会话那一屏。
 * 用户看到的就是"点了没反应"。
 *
 * 所以这一条钉的是外壳的职责：**任何一次跳转都要把它关掉**。
 * 挂在 `fullPath` 上而不是逐个菜单去关，以后新加的页面也不用记得这件事。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

vi.mock('@/composables/useSession', () => ({
  ensureAuthStatus: vi.fn().mockResolvedValue(undefined),
  restoreSession: vi.fn().mockResolvedValue(undefined),
  isAdmin: { value: true },
  logout: vi.fn(),
}))
vi.mock('@/composables/useSessionToken', () => ({
  hasCredential: () => false,
  useReloginPrompt: () => ({ reloginCount: { value: 0 } }),
}))

import App from '@/App.vue'

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/chat/:conversationId?', name: 'chat', component: { template: '<div />' } },
      { path: '/notes/:noteId?', name: 'notes', component: { template: '<div />' } },
      { path: '/login', name: 'login', component: { template: '<div />' } },
    ],
  })
}

async function mountShell(router: Router) {
  await router.push('/chat/c1')
  await router.isReady()
  const wrapper = mount(App, {
    global: {
      plugins: [router],
      stubs: {
        SideNav: { name: 'SideNav', template: '<nav />' },
        RouterView: true,
        ToastStack: true,
      },
    },
  })
  await flushPromises()
  return wrapper
}

function panelOpen(wrapper: ReturnType<typeof mount>): boolean {
  return wrapper.findComponent({ name: 'ConversationHistoryPanel' }).props('open') as boolean
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('历史会话面板与路由', () => {
  it('切到别的菜单会把它关掉：不然"路由变了、屏幕没变"', async () => {
    const router = makeRouter()
    const wrapper = await mountShell(router)

    // 侧栏的「查看全部会话」
    wrapper.findComponent({ name: 'SideNav' }).vm.$emit('openHistory')
    await flushPromises()
    expect(panelOpen(wrapper)).toBe(true)

    await router.push('/notes/n1')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/notes/n1')
    expect(panelOpen(wrapper)).toBe(false)
    wrapper.unmount()
  })

  it('面板里点一条会话（跳到 /chat/…）同样会关掉它', async () => {
    const router = makeRouter()
    const wrapper = await mountShell(router)
    wrapper.findComponent({ name: 'SideNav' }).vm.$emit('openHistory')
    await flushPromises()

    await router.push('/chat/c2')
    await flushPromises()

    expect(panelOpen(wrapper)).toBe(false)
    wrapper.unmount()
  })

  it('不跳转就不关：打开面板本身不改路径，不能被自己关掉', async () => {
    const router = makeRouter()
    const wrapper = await mountShell(router)

    wrapper.findComponent({ name: 'SideNav' }).vm.$emit('openHistory')
    await flushPromises()
    // 等一下：真要是"打开就关"，这里会立刻翻回 false
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(panelOpen(wrapper)).toBe(true)
    wrapper.unmount()
  })
})
