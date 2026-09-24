/**
 * 快捷键（本机偏好，不进后端）——与旧前端 `components/settings/ShortcutsSection.vue` 对应。
 *
 * 这一节是 P2-1 抄 ZCode 那条「快捷键：命令 + 多绑定 + 冲突提示 + 恢复默认」的用户界面。
 * 四件事在这里都能做：**看**（命令、绑定、作用域）、**改**（点「修改」再按一下）、
 * **加/删绑定**（一条命令可以绑好几组键）、**恢复默认**（单条或全部）。
 * 冲突不拦着不让改，只在那一条下面说实话（见 `useShortcuts` 的模块头）。
 */
import { useEffect, useState } from 'react'

import { Button } from '@/ui/button'
import { InfoTip } from '../shared/composites'
import {
  addBinding,
  bindingFromEvent,
  bindingParts,
  conflictMessage,
  isCustomized,
  removeBinding,
  resetAllShortcuts,
  resetCommand,
  setBinding,
  useShortcuts,
  type ShortcutCommand,
  type ShortcutId,
} from './useShortcuts'

const SCOPE_LABEL: Record<ShortcutCommand['scope'], string> = {
  composer: '输入框',
  global: '全局',
}

export function ShortcutsSection() {
  const { commands, bindingsOf } = useShortcuts()
  /** 正在"录制"的那一条（命令 + 第几个绑定）；`null` = 没在录。 */
  const [recording, setRecording] = useState<{ id: ShortcutId; index: number } | null>(null)

  const currentBinding = (id: ShortcutId, index: number): string => bindingsOf(id)[index] ?? ''

  function stopRecording(): void {
    if (recording && !currentBinding(recording.id, recording.index)) {
      removeBinding(recording.id, recording.index)
    }
    setRecording(null)
  }

  /**
   * 录制：**接下来按下的那一组键就是新绑定**（照 ZCode 的"录制"）。
   *
   * 监听挂在 window 的**捕获阶段**：全局那几条快捷键是在 window 的冒泡阶段处理的，
   * 不抢在它前面的话，用户想录 `Ctrl+K` 会先开出一个新会话。
   * Esc 取消录制（它是设置里唯一"不录进去"的键——不然没法退出）。
   */
  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        // 新建的那个空位要收回去：取消录制之后留一条空绑定，界面上会多一个空的键位
        if (!currentBinding(recording.id, recording.index)) {
          removeBinding(recording.id, recording.index)
        }
        setRecording(null)
        return
      }
      const binding = bindingFromEvent(event)
      if (!binding) return // 只按了修饰键：继续等（那不是一组键）
      setBinding(recording.id, recording.index, binding)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

  /** 加一条绑定 = 先占一个空位，再立刻进入录制（不录的空位没有意义）。 */
  function addAndRecord(id: ShortcutId): void {
    const index = addBinding(id)
    setRecording({ id, index })
  }

  return (
    <>
      <h3 className="m-section-title">
        快捷键
        <InfoTip text="只影响这一台机器的浏览器，存在本地。全局那两条在输入框里不生效。" />
      </h3>

      {commands.map((command) => (
        <div key={command.id} className="m-shortcut-row">
          <div className="m-shortcut-main">
            <span className="m-shortcut-label">
              {command.label}
              <span className="m-shortcut-scope">{SCOPE_LABEL[command.scope]}</span>
            </span>
            <span className="m-shortcut-hint">{command.hint}</span>
          </div>

          <div className="m-shortcut-keys">
            {bindingsOf(command.id).map((binding, index) => {
              const isRecording = recording?.id === command.id && recording.index === index
              return (
                <span key={index} className="m-shortcut-binding">
                  <button
                    type="button"
                    className={
                      isRecording ? 'm-shortcut-keys-btn is-recording' : 'm-shortcut-keys-btn'
                    }
                    aria-label={`修改「${command.label}」的第 ${index + 1} 组快捷键`}
                    onClick={() => setRecording({ id: command.id, index })}
                  >
                    {isRecording ? (
                      <kbd className="m-shortcut-recording">按下新快捷键…</kbd>
                    ) : binding ? (
                      bindingParts(binding).map((part, partIndex) => (
                        <kbd key={partIndex}>{part}</kbd>
                      ))
                    ) : (
                      <kbd>未设置</kbd>
                    )}
                  </button>
                  {/* 冲突**就说出来是谁占着**：只说"冲突了"，用户还得自己在这一屏里找 */}
                  {conflictMessage(command.id, binding) && (
                    <span className="m-shortcut-conflict">
                      {conflictMessage(command.id, binding)}
                    </span>
                  )}
                  {bindingsOf(command.id).length > 1 && (
                    <button
                      type="button"
                      className="m-shortcut-remove"
                      aria-label={`删除「${command.label}」的这一组快捷键`}
                      onClick={() => removeBinding(command.id, index)}
                    >
                      删除
                    </button>
                  )}
                </span>
              )
            })}
            <Button
              size="sm"
              disabled={recording !== null}
              onClick={() => addAndRecord(command.id)}
            >
              添加
            </Button>
            {isCustomized(command.id) && (
              <Button
                size="sm"
                disabled={recording !== null}
                onClick={() => resetCommand(command.id)}
              >
                恢复默认
              </Button>
            )}
          </div>
        </div>
      ))}

      {recording && (
        <p className="m-row-note" role="status">
          正在录制「{commands.find((item) => item.id === recording.id)?.label}」：
          按下一组键即可，按 Esc 取消。
          <button type="button" className="m-shortcut-cancel" onClick={stopRecording}>
            取消
          </button>
        </p>
      )}

      <div className="m-shortcut-foot">
        <Button size="sm" onClick={() => resetAllShortcuts()}>
          全部恢复默认
        </Button>
      </div>
    </>
  )
}
