/**
 * 助手头像：**品牌行星标** + 在轨动效（Rive 的 CSS 平替，设计文档 §4）。
 *
 * 为什么不是蓝底加两根白柱（那是初版的 Rive 平替）：两根竖柱在真机上读起来
 * 像**暂停键**（2026-09-30 用户原话"这个头像太雷霆了"）。换成我们自己的环行星标
 * ——几何照抄 `Logo.tsx` 的 mark 档（外圆 145.75 / 环 rx192·ry44 转 -18.5° / 行星点
 * r13.75），只是在这里要单独控制"环"与"点"两层，所以不复用那个组件。
 *
 * 生成中的四层动效（都在 CSS，见 `flow.css`）：
 * 1. **环在进动**：包着椭圆的那层 `g` 绕自己的圆心 3.6s 转一圈，像陀螺上转动的轨道；
 * 2. **行星点脉动**：点在自己的位置做 1.6s 的呼吸（1 ↔ 1.45）；
 * 3. **整颗呼吸**：头像容器 1.6s 的 scale 1 ↔ 1.04；
 * 4. **声纳式扩散环**：外圈一圈描边往外扩再消失（Kimi 官方 breath 的用法）——
 *    这是"它正在干活"的信号，停下来四层全静（`data-live` 一撤就没了）。
 *
 * 笔宽按 `Logo.tsx` 同一条**渲染像素下限**算：外圆/点 1.15px、环 0.8px
 * ——标本身的笔画很细（5.5/299），30px 高度下等比缩只剩 0.55px，不校正就是一片淡灰。
 */
const RENDER_HEIGHT = 30
const MARK_HEIGHT = 299
/** 与 `Logo.tsx` 同一条光学校正：`max(原比例, 下限像素换算回用户单位)`。 */
const stroke = (base: number, minPixels: number): number =>
  Math.max(base, (minPixels * MARK_HEIGHT) / RENDER_HEIGHT)

export function AssistantAvatar({ live }: { live: boolean }) {
  return (
    <span className="ch-avatar" data-live={live || undefined} aria-hidden>
      <svg viewBox="0 0 370 299" fill="none" stroke="#fff" focusable="false">
        <circle cx="182.5" cy="148.5" r="145.75" strokeWidth={stroke(5.5, 1.15)} />
        {/* 环包一层 g：CSS 转的是它（转的是"轨道"本身，行星点不跟着转） */}
        <g className="ch-orbit">
          <ellipse
            cx="185.5"
            cy="155.5"
            rx="192"
            ry="44"
            transform="rotate(-18.5 185.5 155.5)"
            strokeWidth={stroke(2.2, 0.8)}
          />
        </g>
        <circle className="ch-planet" cx="318.5" cy="147" r="13.75" strokeWidth={stroke(5.5, 1.15)} />
      </svg>
    </span>
  )
}
