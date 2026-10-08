/**
 * 调用点的**分流**（2026-10-05 起两批：`LOCAL_PATHS` 补上 `/skills`、`/plugins`、
 * `/sandbox`、`/site-icons`、`/stats/usage` 之后的另一半；同一轮稍后补上技能市场那六条
 * 与命令目录 `/chat/commands`）。
 *
 * 那张前缀表只说明"这份数据的主人是谁"，**它自己不改变任何请求的落点**——
 * 落点由调用点选哪个函数决定（`request` 恒打服务器，`requestLocal` 才过那张表）。
 * 于是"表补上了、调用点还走 `request`"就成了最难看的一种缺口：**看起来接好了**，
 * 而壳里读的仍是 NAS 上那份（或 404）。技能市场那六条正是这个缺口的**活标本**：
 * 壳里"列技能"读本机、而"装技能"装到服务器那份 `data_dir` ⇒ 装完列不出来。
 *
 * 这一份就是那把尺子：**真调那些函数、看请求打到哪个基址**（不打真网络，`fetch` 是替身）。
 *
 * | 档 | 该打哪 | 为什么这是对的 |
 * | --- | --- | --- |
 * | 有本机后端（桌面壳 / 浏览器直连边车） | `http://127.0.0.1:<port>/api/v1/…` | 这几族的数据就在这台机器上（技能目录与市场安装记录、插件目录、站点图标缓存、本机用量、命令目录） |
 * | 没有（NAS 网页端那一份） | `/api/v1/…`（同源服务器） | 那一档里本机后端不存在，`resolveLocalBase` 落到 `API_BASE`（不是"回退"，是这一档不成立） |
 *
 * 底层的选址与三条回退纪律在 `tests/unit/api/sidecar.test.ts` 里逐条钉着，
 * 这里只钉**调用点真的用了它**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addSkillSource,
  browseSkillSource,
  deleteSkillSource,
  getSkill,
  inspectMarketSkill,
  installMarketSkill,
  listInstalledSkills,
  listSkills,
  listSkillSources,
  setSkillEnabled,
  setSkillSourceEnabled,
  uninstallSkill,
  uploadSkill,
} from '@/api/capabilities'
import { listCommands } from '@/api/chat'
import { API_BASE } from '@/api/client'
import { disablePlugin, enablePlugin, listPlugins } from '@/api/plugins'
import { DEFAULT_SIDECAR_BASE, resetSidecarProbe } from '@/api/sidecar'
import { getUsage } from '@/api/stats'
import { checkWebEmbed, fetchWebPage } from '@/api/web'
import { loadSiteIcon, resetSiteIconCache } from '@/features/chat/ui/siteLogos'

/**
 * 这一轮**改了的那几处**，一处一次（顺序就是执行顺序）。
 *
 * 表里逐条列出来而不是只挑一条代表：这一份要防的正是"改了一半"——漏掉的那一条
 * 在真机上表现为"这一列空的、那一列有"，比整族都错更难查。
 */
const CALL_SITES: { path: string; call: () => Promise<unknown> }[] = [
  // 技能：清单 / 正文 / 启停 / 技能源
  { path: '/skills', call: () => listSkills() },
  { path: '/skills/demo', call: () => getSkill('demo') },
  { path: '/skills/demo/enabled', call: () => setSkillEnabled('demo', false) },
  { path: '/skills/market/sources', call: () => listSkillSources() },
  { path: '/skills/market/sources', call: () => addSkillSource('owner/repo') },
  { path: '/skills/market/sources/gh', call: () => setSkillSourceEnabled('gh', false) },
  { path: '/skills/market/sources/gh', call: () => deleteSkillSource('gh') },
  // 技能市场那六条（2026-10-05 收口："装到服务器那份 data_dir"是个真 bug）
  { path: '/skills/market/browse', call: () => browseSkillSource('gh') },
  { path: '/skills/market/browse', call: () => browseSkillSource('gh', true) },
  { path: '/skills/market/inspect', call: () => inspectMarketSkill('gh', 'demo') },
  { path: '/skills/market/install-source', call: () => installMarketSkill('gh', 'demo') },
  {
    path: '/skills/market/upload',
    call: () =>
      uploadSkill([new File(['# 技能'], 'SKILL.md', { type: 'text/markdown' })], ['SKILL.md']),
  },
  { path: '/skills/market/installed', call: () => listInstalledSkills() },
  { path: '/skills/market/installed/demo', call: () => uninstallSkill('demo') },
  // 命令目录（2026-10-05 从服务器挪回本机：目录与执行同源）
  { path: '/chat/commands', call: () => listCommands() },
  // 插件包
  { path: '/plugins', call: () => listPlugins() },
  { path: '/plugins/p1/enable', call: () => enablePlugin('p1') },
  { path: '/plugins/p1/disable', call: () => disablePlugin('p1') },
  // 用量
  { path: '/stats/usage?days=30', call: () => getUsage() },
  // 网页（本机代取：抓正文与嵌入门检都在这台机器上跑，SSRF 闸也在本机）
  {
    path: '/web/page?url=https%3A%2F%2Fexample.com',
    call: () => fetchWebPage('https://example.com'),
  },
  {
    path: '/web/embed-check?url=https%3A%2F%2Fexample.com',
    call: () => checkWebEmbed('https://example.com'),
  },
  // 站点图标（裸 `fetch`，但也得先问出基址）
  { path: '/site-icons?domain=example.com', call: () => loadSiteIcon('example.com') },
]

function jsonOk(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 边车活着（`/health` 200），业务请求一律 200 + 空 JSON。 */
function liveSidecar(): typeof fetch {
  return vi.fn(async (url: string) =>
    String(url).endsWith('/health') ? jsonOk({ ok: true }) : jsonOk(),
  ) as unknown as typeof fetch
}

/** 浏览器里那一份：边车不在（只有探活那一条不通），服务器那条链是活的。 */
function noLocalBackend(): typeof fetch {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith('/health')) throw new TypeError('ECONNREFUSED')
    return jsonOk()
  }) as unknown as typeof fetch
}

function urlsOf(mock: typeof fetch): string[] {
  return vi.mocked(mock).mock.calls.map((call) => String(call[0]))
}

/**
 * jsdom 没有 `URL.createObjectURL`，而 `fetchSiteIcon` 没有它就直接退化（那一支不发请求）
 * ——这一条要验的正是"发到哪台"，所以按最窄的方式补上，用完撤掉。
 */
function stubObjectUrl(): void {
  Object.defineProperty(URL, 'createObjectURL', {
    value: () => 'blob:用例替身',
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  stubObjectUrl()
  resetSidecarProbe()
})

afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL')
  resetSiteIconCache()
  resetSidecarProbe()
  vi.unstubAllGlobals()
})

describe('① 有本机后端：五族都打本机那个端口', () => {
  it('技能 / 插件包 / 用量 / 站点图标：基址是本机边车，一条都没落到服务器', async () => {
    const fetchMock = liveSidecar()
    vi.stubGlobal('fetch', fetchMock)

    for (const site of CALL_SITES) await site.call()

    const urls = urlsOf(fetchMock)
    // 头一条是探活（`/health`），它必须打在同一个基址上
    expect(urls[0]).toBe(`${DEFAULT_SIDECAR_BASE}/health`)
    expect(urls.slice(1)).toEqual(
      CALL_SITES.map((site) => `${DEFAULT_SIDECAR_BASE}${API_BASE}${site.path}`),
    )
    // 一条都没有落到服务器那条相对链上（`request()` 拼出来长这样）
    for (const url of urls.slice(1)) expect(url.startsWith(API_BASE)).toBe(false)
  })
})

describe('② 没有本机后端（NAS 网页端那一份）：照旧打服务器', () => {
  it('同一批调用点落到同源服务器上（这一档本机后端不存在，不是"回退"）', async () => {
    const fetchMock = noLocalBackend()
    vi.stubGlobal('fetch', fetchMock)

    for (const site of CALL_SITES) await site.call()

    const urls = urlsOf(fetchMock)
    // 探活那一下打的是构建期那份常量（浏览器开发形态），不通就算了——那不叫回退
    expect(urls[0]).toBe(`${DEFAULT_SIDECAR_BASE}/health`)
    expect(urls.slice(1)).toEqual(CALL_SITES.map((site) => `${API_BASE}${site.path}`))
  })
})
