/**
 * 工作区的「绑定的知识库」勾选组（v0.25 抽出）。
 *
 * 新建弹窗与编辑表单**都要用它**，而它的样式不是随手写的一段——选中的胶囊用
 * `--bg-selected`（中性 alpha）而不是品牌色，靠底色表达"已绑定"，
 * 这一点两处必须一致，否则同一个控件在弹窗里和页面里长得不一样。
 *
 * 取值口径：胶囊高 `--control-height`（与输入框、按钮同高）、圆角 999（胶囊），
 * 选中态去掉描边——描边 + 底色同时出现会读成"按钮被按下"，而这里表达的是状态。
 *
 * ## 文案的两处修正（如实）
 *
 * 旧提示写着"绑定的库会被这个工作区里的新会话**自动继承**"，而实测是：
 * **每一轮查哪些库由输入框当时的选择决定**（后端那一轮的 `kb_ids` 取请求里的，
 * 不是会话记下的那份）。所以这里改成两句站得住的话：
 *
 * 1. 绑定 = **这个项目里新会话的默认库**（新会话建起来时按它定范围，进对话后随时可改）；
 * 2. **不绑也能用**：对话里用 `@` 点一个库、或在输入框的「知识库」里临时勾，
 *    每一轮各算各的。
 */
import { InfoTip } from '../shared/composites'

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
        <InfoTip
          text={
            '绑定的库是这个项目里新会话的默认库：在这个项目里新开一条会话，资料范围就按它起。' +
            '不绑也能用——对话里打 @ 就能点一个库并进检索范围，或用输入框的「知识库」临时勾。'
          }
        />
      </span>
      {items.length === 0 ? (
        <p className="text-micro">
          还没有知识库可绑。不绑也能用：对话里用 @ 或输入框的「知识库」临时选。
        </p>
      ) : (
        <>
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
          {/* 空着也可以：这条不是"建议你绑"，而是**说清不绑会发生什么**——原先
              没有一个字提到"可以不绑"，于是"项目必须挂一堆库"像是这一页的规矩 */}
          <p className="text-micro">
            不绑也行：对话里打 @ 就能把某个库并进检索范围，或用输入框的「知识库」临时勾——
            每一轮各算各的。
          </p>
        </>
      )}
    </div>
  )
}
