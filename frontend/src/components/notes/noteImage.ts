/**
 * 笔记配图节点：在 Tiptap 官方 `Image` 上补一件事——**把尺寸写进 Markdown**。
 *
 * 尺寸从哪来：`Image` 自带 `resize`（内部是 Tiptap 的 `ResizableNodeView`），
 * 拖右下角时把宽高写进节点的 `width` / `height` 属性（DOM 上就是 `<img width height>`）。
 *
 * 为什么还要这个扩展：正文是 Markdown、是唯一事实源，而 `tiptap-markdown` 给 image
 * 用的序列化只写 `![alt](src "title")`（官方 `Image` 自带的 `renderMarkdown` 同样只写
 * 这三个），**尺寸会在存盘时被丢掉**，刷新回来就复原了。所以这里给尺寸在 Markdown 里
 * 找个位置，用的是 Pandoc 那套后缀：`![alt](src){width=460}`。
 *
 * 为什么不用裸 HTML（`<img src width>`）：正文解析走的是
 * `Markdown.configure({ html: false })`，裸标签会被当纯文本渲染出来，比丢了尺寸更糟。
 * 后缀是人读得懂的、可被别的工具忽略的一行，出问题时肉眼也能对。
 *
 * 只写 width 不写 height：高度由宽度与图片自身的比例决定（CSS 里 `height: auto`，
 * 见 NoteCanvas）。写死高度反而会在换图/改比例时留下一个对不上的旧高度。
 * 解析这一侧容忍标记里带 height（吃掉、不用），免得别人写进来的高度变成正文文字。
 *
 * 实现落点在 markdown-it：`parse.setup` 拿到的实例上加一条 core 规则，在 `inline`
 * 之后把后缀收进 image token 的属性里——markdown-it 的渲染器会把 `token.attrs`
 * 全部输出成 HTML 属性，再交给 `Image` 自带的属性解析（`img[width]` → `attrs.width`）。
 * 注意 `tiptap-markdown` **每次 parse 都会重跑所有扩展的 setup**，所以这里必须幂等
 * （重复注册同名规则会让 ruler 无限增长）。
 */
import Image from '@tiptap/extension-image'

/**
 * markdown-it 的最小结构面。
 *
 * 它是 `tiptap-markdown` 的传递依赖，pnpm 的 node_modules 里访问不到，直接
 * `import type from 'markdown-it'` 会解析失败；真正用到的只有下面这几个成员，
 * 就地声明比为了类型去改依赖树划算。
 */
interface MdToken {
  type: string
  content: string
  attrSet(name: string, value: string): void
}

interface MdCoreState {
  tokens: { children?: MdToken[] | null }[]
}

interface MdInstance {
  core: { ruler: { after(name: string, rule: string, fn: (state: MdCoreState) => void): void } }
}

/** 序列化状态的最小结构面（同上，prosemirror-markdown 是传递依赖）。 */
interface MarkdownState {
  write(text: string): void
  esc(text: string): string
}

interface ImageNodeLike {
  attrs: { src?: unknown; alt?: unknown; title?: unknown; width?: unknown }
}

/** 紧跟在图片语法之后的大小标记；height 收下但不用（见文件头）。 */
const SIZE_MARKER = /^\s*\{width=(\d+)(?:\s+height=\d+)?\}/

/** 尺寸只认正整数像素：拖出来的宽高就是 px，其它形状（空串、'auto'、百分比）一律当没有。 */
function pixelSize(value: unknown): number | null {
  const size = Math.round(Number(value))
  return Number.isFinite(size) && size > 0 ? size : null
}

export const NoteImage = Image.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownState, node: ImageNodeLike): void {
          const src = String(node.attrs.src ?? '').replace(/[()]/g, '\\$&')
          const alt = state.esc(String(node.attrs.alt ?? ''))
          const title = node.attrs.title
            ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"`
            : ''
          state.write(`![${alt}](${src}${title})`)
          const width = pixelSize(node.attrs.width)
          if (width) state.write(`{width=${width}}`)
        },

        parse: {
          setup(md: MdInstance): void {
            const instance = md as MdInstance & { kylabNoteImageSize?: boolean }
            if (instance.kylabNoteImageSize) return
            instance.kylabNoteImageSize = true

            md.core.ruler.after('inline', 'kylab-note-image-size', (state) => {
              for (const block of state.tokens) {
                const children = block.children
                if (!children) continue
                children.forEach((token, index) => {
                  if (token.type !== 'image') return
                  const next = children[index + 1]
                  // 后缀是图片后面的一个文本 token：`![a](b){width=460}`
                  if (!next || next.type !== 'text') return
                  const match = SIZE_MARKER.exec(next.content)
                  if (!match) return
                  token.attrSet('width', match[1])
                  next.content = next.content.slice(match[0].length)
                })
              }
            })
          },
        },
      },
    }
  },
})

export default NoteImage
