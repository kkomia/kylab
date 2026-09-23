/**
 * 快捷键注册表（P2-1，照 ZCode 的「命令 + 多绑定 + 冲突检测 + 恢复默认」）。
 *
 * 这一组钉四件事，正好是验收④：**能改**、**冲突有提示**、**恢复默认可用**、
 * **刷新后还在**（存 localStorage）。外加两条匹配上的硬要求——
 * 修饰键要精确对上（不然 Shift+回车换行会被回车发送抢走）、
 * 输入法组合中的回车不算发送。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  SHORTCUTS_STORAGE_KEY,
  addBinding,
  bindingFromEvent,
  bindingParts,
  bindingsOf,
  canonicalBinding,
  conflictMessage,
  isCustomized,
  isTypingTarget,
  matchShortcut,
  parseBinding,
  removeBinding,
  resetAllShortcuts,
  resetCommand,
  setBinding,
} from '@/composables/useShortcuts'

/** 造一个键盘事件（`init` 里只写"多按了哪些修饰键"）。 */
function key(keyName: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: keyName, ...init })
}

beforeEach(() => {
  window.localStorage.clear()
  // 每条用例从默认值起步：注册表是模块级单例（设置页与运行时读同一份）
  resetAllShortcuts()
})

describe('默认绑定', () => {
  it('四条命令各有默认值，其中三条是界面上本来就写着的', () => {
    expect(bindingsOf('chat.send')).toEqual(['Enter', 'Mod+Enter'])
    expect(bindingsOf('chat.newline')).toEqual(['Shift+Enter'])
    expect(bindingsOf('chat.new')).toEqual(['Mod+K'])
    expect(bindingsOf('layout.toggleSidebar')).toEqual(['Mod+B'])
  })

  it('没改过 = 不是自定义（设置页据此不显示「恢复默认」）', () => {
    expect(isCustomized('chat.send')).toBe(false)
    setBinding('chat.send', 0, 'Mod+Enter')
    expect(isCustomized('chat.send')).toBe(true)
  })
})

describe('改绑定', () => {
  it('改完之后**写进 localStorage**：刷新（重新读模块）也还在', () => {
    setBinding('chat.new', 0, 'Mod+Shift+O')

    const raw = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string)).toEqual({ 'chat.new': ['Mod+Shift+O'] })
    expect(bindingsOf('chat.new')).toEqual(['Mod+Shift+O'])
  })

  it('一条命令可以**多个绑定**（加一条、删一条）', () => {
    const index = addBinding('chat.send')
    expect(bindingsOf('chat.send')).toHaveLength(3)

    setBinding('chat.send', index, 'Mod+J')
    expect(bindingsOf('chat.send')).toEqual(['Enter', 'Mod+Enter', 'Mod+J'])

    removeBinding('chat.send', 2)
    expect(bindingsOf('chat.send')).toEqual(['Enter', 'Mod+Enter'])
  })

  it('恢复默认：单条与全部', () => {
    setBinding('chat.new', 0, 'Mod+Shift+O')
    setBinding('layout.toggleSidebar', 0, 'Mod+Shift+B')
    resetCommand('chat.new')

    expect(bindingsOf('chat.new')).toEqual(['Mod+K'])
    expect(isCustomized('chat.new')).toBe(false)
    // 另一条不受影响：单条恢复不该把别的改动一起抹掉
    expect(bindingsOf('layout.toggleSidebar')).toEqual(['Mod+Shift+B'])

    resetAllShortcuts()
    expect(bindingsOf('layout.toggleSidebar')).toEqual(['Mod+B'])
    // 全部恢复默认之后本机记录就不该留着（否则以后改默认值会被老记录挡着）
    expect(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBeNull()
  })
})

describe('冲突检测', () => {
  it('撞上别人的绑定就说**是谁占着**', () => {
    setBinding('chat.send', 0, 'Mod+K')
    expect(conflictMessage('chat.send', 'Mod+K')).toBe('已被「新建会话」占用')
    // 没撞上就什么都不说
    expect(conflictMessage('chat.send', 'Mod+J')).toBe('')
    // 自己跟自己的另一条绑定重复不算冲突（同一条命令的多条绑定本来就等价）
    expect(conflictMessage('chat.send', 'Mod+Enter')).toBe('')
  })

  it('写法不同、其实是同一组键也算冲突（规范形式比对）', () => {
    expect(canonicalBinding('shift+mod+k')).toBe('Mod+Shift+K')
    expect(canonicalBinding('Mod+Shift+K')).toBe('Mod+Shift+K')
    setBinding('chat.new', 0, 'Shift+Mod+K')
    expect(conflictMessage('chat.send', 'Mod+Shift+K')).toBe('已被「新建会话」占用')
  })

  it('认不出来的绑定不当成某组键（解析失败就忽略）', () => {
    expect(parseBinding('')).toBeNull()
    expect(parseBinding('K+J')).toBeNull()
    expect(canonicalBinding('K+J')).toBe('')
    expect(conflictMessage('chat.send', 'K+J')).toBe('')
  })
})

describe('匹配', () => {
  it('作用域分开：输入框的命令不会被全局那两条抢走', () => {
    expect(matchShortcut(key('Enter'), 'composer')).toBe('chat.send')
    expect(matchShortcut(key('Enter'), 'global')).toBe('')
    expect(matchShortcut(key('k', { ctrlKey: true }), 'global')).toBe('chat.new')
    expect(matchShortcut(key('k', { ctrlKey: true }), 'composer')).toBe('')
  })

  it('**修饰键要精确对上**：Shift+回车是换行，不是发送', () => {
    expect(matchShortcut(key('Enter', { shiftKey: true }), 'composer')).toBe('chat.newline')
    expect(matchShortcut(key('Enter', { ctrlKey: true }), 'composer')).toBe('chat.send')
    // 多按一个 Alt 就不匹配任何一条（宁可不动，也不要猜）
    expect(matchShortcut(key('Enter', { altKey: true }), 'composer')).toBe('')
  })

  it('macOS 的 Cmd 与 Ctrl 等价（绑定里写的是 Mod）', () => {
    expect(matchShortcut(key('b', { metaKey: true }), 'global')).toBe('layout.toggleSidebar')
  })

  it('输入法组合中的回车不算发送（那是在选词）', () => {
    const event = key('Enter')
    Object.defineProperty(event, 'isComposing', { value: true })
    expect(matchShortcut(event, 'composer')).toBe('')
  })
})

describe('录制与展示', () => {
  it('按一下得到一条绑定串；只按修饰键时不算', () => {
    expect(bindingFromEvent(key('O', { ctrlKey: true, shiftKey: true }))).toBe('Mod+Shift+O')
    expect(bindingFromEvent(key('Enter'))).toBe('Enter')
    expect(bindingFromEvent(key(' '))).toBe('Space')
    expect(bindingFromEvent(key('Control', { ctrlKey: true }))).toBeNull()
    expect(bindingFromEvent(key('Shift', { shiftKey: true }))).toBeNull()
  })

  it('展示成小片：Mod 显示成 Ctrl（与侧栏那处同一口径）', () => {
    expect(bindingParts('Mod+K')).toEqual(['Ctrl', 'K'])
    expect(bindingParts('Shift+Enter')).toEqual(['Shift', 'Enter'])
  })

  it('敲字的地方认得出（全局那两条在它们上面不生效）', () => {
    const input = document.createElement('input')
    const box = document.createElement('div')
    expect(isTypingTarget({ target: input } as unknown as KeyboardEvent)).toBe(true)
    expect(isTypingTarget({ target: box } as unknown as KeyboardEvent)).toBe(false)
  })
})
