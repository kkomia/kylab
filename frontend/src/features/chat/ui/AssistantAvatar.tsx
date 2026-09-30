/**
 * 助手头像：**品牌行星标**（2026-09-30 三版，按用户逐条批注改）。
 *
 * 批注史：
 * - 一版（双白柱）：像暂停键——"太雷霆了"；
 * - 二版（环自转 + 蓝圆底）："旋转肯定要卫星围绕主星转啊" + "蓝色底太突兀"；
 * - 三版（本版）：卫星沿轨道跑 + 无底色；再按"常驻动效"与"环上的卫星没了"两条修。
 *
 * ## 卫星为什么用 SMIL（`<animateMotion>`）而不是 CSS `offset-path`
 *
 * 二版用 CSS `offset-path: path(...)` 让圆点沿椭圆走——**真机上卫星直接消失了**：
 * `offset-path` 的坐标基准是元素的 reference box（对 SVG 子元素各浏览器口径不一），
 * 路径落点被整体平移出画布。`<animateMotion>` 的 `path` 是**SVG 用户坐标**，
 * 基准确定，不吃这套歧义。路径按"圆点自己位置 = 基准原点"的约定给了**相对坐标**
 * （绝对轨道点减去圆心 `(318.5, 147)`），所以静止那一帧就落在设计点上、起播不跳。
 *
 * 常驻：卫星绕 4s 一圈 + 整颗 1.6s 呼吸**永远在跑**（用户："常驻动效"）；
 * 只有外圈声纳是"正在干活"的信号，仍然只跟 `data-live`。
 * `prefers-reduced-motion` 下卫星停走（不挂 `animateMotion`）、CSS 那两层也停。
 *
 * 几何照抄 `Logo.tsx` 的 mark 档；笔宽走同一条**渲染像素下限**（外圆/点 1.15px、
 * 环 0.8px；标本身笔画 5.5/299，30px 高度下等比缩只剩 0.55px，不校正就是一片淡灰）。
 */
const RENDER_HEIGHT = 30
const MARK_HEIGHT = 299
/** 与 `Logo.tsx` 同一条光学校正：`max(原比例, 下限像素换算回用户单位)`。 */
const stroke = (base: number, minPixels: number): number =>
  Math.max(base, (minPixels * MARK_HEIGHT) / RENDER_HEIGHT)

/**
 * 轨道路径（相对圆点自身的坐标，见文件头）：起点 ≈ 圆点设计位，
 * 对端是椭圆另一头；两段 A 弧拼出完整一圈。
 * 绝对轨道的参数：中心 (185.5,155.5)、rx 192、ry 44、转 -18.5°（`Logo.tsx` 同一份）。
 */
const ORBIT_PATH = 'M -3.3 0.2 A 192 44 -18.5 0 1 -262.7 16.8 A 192 44 -18.5 0 1 -3.3 0.2'

function prefersReducedMotion(): boolean {
  // 渲染时读一次就够：OS 设置会话中途变的场景不值一次监听（刷新即生效）
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function AssistantAvatar({ live }: { live: boolean }) {
  const reduced = prefersReducedMotion()
  return (
    <span className="ch-avatar" data-live={live || undefined} aria-hidden>
      {/* `stroke=currentColor`：颜色由 CSS 给（品牌蓝），深浅主题都跟着走 */}
      <svg viewBox="0 0 370 299" fill="none" stroke="currentColor" focusable="false">
        <circle cx="182.5" cy="148.5" r="145.75" strokeWidth={stroke(5.5, 1.15)} />
        <ellipse
          cx="185.5"
          cy="155.5"
          rx="192"
          ry="44"
          transform="rotate(-18.5 185.5 155.5)"
          strokeWidth={stroke(2.2, 0.8)}
        />
        {/* 卫星：沿椭圆轨道跑（常驻；reduced-motion 下停在设计位） */}
        <circle className="ch-planet" cx="318.5" cy="147" r="13.75" strokeWidth={stroke(5.5, 1.15)}>
          {reduced ? null : <animateMotion dur="4s" repeatCount="indefinite" path={ORBIT_PATH} />}
        </circle>
      </svg>
    </span>
  )
}
