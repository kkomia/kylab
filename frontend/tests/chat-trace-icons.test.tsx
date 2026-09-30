/**
 * 过程面板那一列的**图形选型**（§12.334 第一节）与**状态灯**（第二节）。
 *
 * 为什么这样断言：SVG 的形状在用例里说明不了它是哪一张，而"思考那一步画的是机器人不是脑子"
 * 这种回归恰恰是肉眼扫不出来的。lucide 给每枚图标带了一个 `lucide-<名字>` 的类名，
 * 拿它把"画出来的到底是哪一张"钉死；`data-icon` / `data-outcome` 则钉住界面**自己报出来**的档位
 * （用例与无障碍都读它）。
 *
 * 第二组用例钉的是一件容易做丢的事：**联网与"检索知识库"在后端是同一个 `kind`**
 * （`search`：只读 + 影响面 network），而 §12.334 要的是"检索 → 放大镜、联网 → 地球"。
 * 所以图形在渲染层按工具名再分一档——这组用例同时钉住"联网变地球"与"本地的检索没跟着变"。
 *
 * 2026-09-30 用户批注又把**联网自己**分成两档（"获取网页用的是不同于搜索网页的图标"）：
 * 联网搜索仍是地球、抓取网页换成浏览器窗口那一枚（`PanelTop`，参考 Kimi 的 Browser）。
 * 于是这一组钉住的是三件事：**搜索 = 地球、抓页 = 窗口、本地的检索照旧放大镜**。
 */
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import type { TraceIcon } from '@/features/chat/model/turns'
import { StepIcon, StepOutcomeBadge, type StepOutcome } from '@/features/chat/ui/stepIcons'

/** 渲染一枚图标，返回那枚 SVG（`lucide-*` 这个类名就是它的身份）。 */
function glyph(element: ReactElement): SVGElement {
  const { container } = render(element)
  return container.querySelector('svg') as SVGElement
}

describe('图标选型：每一档画哪一张（§12.334）', () => {
  const cases: [TraceIcon, string][] = [
    // 非工具步骤两档（2026-09-30 换 Kimi chat 同款）：思考 = 💡 灯泡（Kimi「思考已完成」
    // 原样）；组织回答 = 笔（Kimi「写入」那一族，"在写回答"）
    ['think', 'lucide-lightbulb'],
    ['build', 'lucide-pen-line'],
    // 工具步骤：读文件是文件、写入是笔、删除是垃圾桶
    ['read', 'lucide-file-text'],
    ['search', 'lucide-search'],
    ['write', 'lucide-pencil'],
    ['delete', 'lucide-trash'],
    // 执行命令用终端：比原来的 `SquareCode` 少一层"这是代码"的误导（跑的是命令）
    ['exec', 'lucide-square-terminal'],
    // 技能是"一份可以逐条打勾的清单"（Kimi 待办清单同款）、会话/子 Agent 是"几个来回的对话"
    ['skill', 'lucide-list-todo'],
    ['session', 'lucide-messages-square'],
    ['message', 'lucide-message-square'],
    // 认不出来的外部工具：中性一档，不猜
    ['tool', 'lucide-server'],
  ]

  it.each(cases)('%s 画 %s，并如实报 data-icon', (icon: TraceIcon, className: string) => {
    const svg = glyph(<StepIcon icon={icon} />)
    expect(svg).toHaveClass(className)
    expect(svg).toHaveAttribute('data-icon', icon)
  })
})

describe('联网的两档：搜索与抓页分开画（三者同 kind=search）', () => {
  it('web_search 画地球，data-icon 报 web', () => {
    const search = glyph(<StepIcon icon="search" tool="web_search" />)
    expect(search).toHaveClass('lucide-globe')
    expect(search).toHaveAttribute('data-icon', 'web')
  })

  it('web_fetch 画浏览器窗口（PanelTop），data-icon 报 fetch', () => {
    /*
      2026-09-30 用户批注"获取网页用的是不同于搜索网页的图标"：抓页读的是"打开这一页"，
      与"又搜了一次"是两件事，两枚图形。形状参考 Kimi 的 Browser 那一枚（窗口顶上一条
      横栏就是地址栏的位置），落在 `lucide` 的 `PanelTop` 上；备选 `AppWindow` 那三条
      小竖痕在 15px 下糊成一团，所以是二选一里的这一枚。

      顺带钉住 `data-icon`：它报的是**画出来的那一张**（`fetch`），而 `data-kind` 仍然是
      后端那个语义种类（`search`）——两个口径各自都对。
    */
    const fetch = glyph(<StepIcon icon="search" tool="web_fetch" />)
    expect(fetch).toHaveClass('lucide-panel-top')
    expect(fetch).toHaveAttribute('data-icon', 'fetch')
  })

  it('本地的两档照旧是放大镜（别把"在本地翻"也画成上网）', () => {
    // 知识库检索 `search`、在文件里搜 `search_files`
    expect(glyph(<StepIcon icon="search" tool="search" />)).toHaveClass('lucide-search')
    expect(glyph(<StepIcon icon="search" tool="search_files" />)).toHaveClass('lucide-search')
    // 连工具名都没有（老快照、非工具步骤）也是放大镜
    expect(glyph(<StepIcon icon="search" />)).toHaveClass('lucide-search')
  })

  it('老快照（没有工具名）按当时的标签认：联网搜索 → 地球、抓取网页 → 窗口', () => {
    expect(glyph(<StepIcon icon="search" label="联网搜索" />)).toHaveClass('lucide-globe')
    expect(glyph(<StepIcon icon="search" label="抓取网页" />)).toHaveClass('lucide-panel-top')
    // 同期的"检索知识库"仍然是放大镜
    expect(glyph(<StepIcon icon="search" label="检索知识库" />)).toHaveClass('lucide-search')
  })
})

describe('状态灯：失败 / 被拦下 / 在等确认（§12.334 第二节）', () => {
  /** 三档的图形与颜色（颜色只从 `--status-*` 那几枚令牌取）。 */
  const cases: [StepOutcome, string, string][] = [
    ['failed', 'lucide-circle-x', 'text-[var(--status-danger)]'],
    ['blocked', 'lucide-shield-x', 'text-[var(--text-tertiary)]'],
    ['awaiting', 'lucide-hand', 'text-[var(--status-warning)]'],
  ]

  it.each(cases)('%s 画 %s', (outcome: StepOutcome, className: string, colorClass: string) => {
    const svg = glyph(<StepOutcomeBadge outcome={outcome} />)
    expect(svg).toHaveClass(className)
    expect(svg).toHaveClass(colorClass)
    expect(svg).toHaveAttribute('data-outcome', outcome)
    expect(svg).toHaveAttribute('data-testid', 'step-outcome')
  })

  it('与转圈**同一格**：挂在图标圆底的右下角（另起一列会让整行文字往左跳）', () => {
    const svg = glyph(<StepOutcomeBadge outcome="failed" />)
    const className = svg.getAttribute('class') ?? ''
    expect(className).toContain('absolute')
    expect(className).toContain('-right-[4px]')
    expect(className).toContain('-bottom-[4px]')
  })
})
