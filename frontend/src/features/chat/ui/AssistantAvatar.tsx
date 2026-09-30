/**
 * 助手头像：**品牌行星标**（2026-09-30 二版，按用户两条批注改）。
 *
 * 批注①：「旋转肯定要卫星围绕主星转啊」——一版转的是环本身（原地进动），不对；
 * 现在是**行星点沿着那条倾斜椭圆（轨道）绕主星跑圈**，环就是它的轨道线（静止）。
 * 批注②：「蓝色底太突兀了」——去掉实心圆底，标直接以**品牌蓝**落在画布上。
 *
 * 几何照抄 `Logo.tsx` 的 mark 档（外圆 145.75 / 轨道椭圆 rx192·ry44 转 -18.5° /
 * 行星点 r13.75），只是在这里行星点要单独驱动，所以不复用那个组件。笔宽同样走
 * 那条**渲染像素下限**（外圆/点 1.15px、环 0.8px；标本身笔画 5.5/299，30px 高度
 * 下等比缩只剩 0.55px，不校正就是一片淡灰）。
 *
 * 生成中的三层动效（CSS 在 `flow.css`）：行星点绕轨道 4s 一圈（`offset-path`，
 * 路径起点取在点自己的落点上，起播不跳）、整颗 1.6s 呼吸、外圈声纳式扩散环；
 * `data-live` 一撤三层全静。
 */
const RENDER_HEIGHT = 30
const MARK_HEIGHT = 299
/** 与 `Logo.tsx` 同一条光学校正：`max(原比例, 下限像素换算回用户单位)`。 */
const stroke = (base: number, minPixels: number): number =>
  Math.max(base, (minPixels * MARK_HEIGHT) / RENDER_HEIGHT)

export function AssistantAvatar({ live }: { live: boolean }) {
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
        {/* 卫星：沿轨道跑（`offset-path` 在 CSS 里） */}
        <circle
          className="ch-planet"
          cx="318.5"
          cy="147"
          r="13.75"
          strokeWidth={stroke(5.5, 1.15)}
        />
      </svg>
    </span>
  )
}
