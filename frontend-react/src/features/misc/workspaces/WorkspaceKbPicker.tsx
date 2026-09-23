/**
 * 工作区的「绑定的知识库」勾选组（v0.25 抽出）。
 *
 * 新建弹窗与编辑表单**都要用它**，而它的样式不是随手写的一段——选中的胶囊用
 * `--bg-selected`（中性 alpha）而不是品牌色，靠底色表达"已绑定"，
 * 这一点两处必须一致，否则同一个控件在弹窗里和页面里长得不一样。
 *
 * 取值口径：胶囊高 `--control-height`（与输入框、按钮同高）、圆角 999（胶囊），
 * 选中态去掉描边——描边 + 底色同时出现会读成"按钮被按下"，而这里表达的是状态。
 */
import { InfoTip } from '../shared/ui'

export function WorkspaceKbPicker({
  items,
  value,
  onChange,
}: {
  items: { id: string; name: string }[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (kbId: string) => {
    onChange(value.includes(kbId) ? value.filter((item) => item !== kbId) : [...value, kbId])
  }

  return (
    <div className="field">
      <span className="field-label">
        绑定的知识库
        <InfoTip text="绑定的库会被这个工作区里的新会话自动继承：进入项目，资料范围就定了，不必每次重勾。知识库与记忆仍是两个池子，检索结果不会混。" />
      </span>
      {items.length === 0 ? (
        <p className="text-micro">还没有知识库可绑。</p>
      ) : (
        <ul className="m-kb-picks">
          {items.map((kb) => {
            const on = value.includes(kb.id)
            return (
              <li key={kb.id}>
                <button
                  type="button"
                  className={on ? 'm-kb-pick m-kb-pick-on' : 'm-kb-pick'}
                  aria-pressed={on}
                  onClick={() => toggle(kb.id)}
                >
                  <span>{kb.name}</span>
                  {on && <span className="m-kb-pick-mark">已绑定</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
