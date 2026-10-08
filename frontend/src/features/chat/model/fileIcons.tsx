/**
 * 一份文件**长什么样**的那一枚图形：按后缀分档（Kimi 的文件卡片：代码 `</>`、表格 grid、
 * 幻灯、图片、文档）。
 *
 * 这份表原先只住在产物卡片里（`ui/Deliverables.tsx` 的 `ARTIFACT_ICONS`）。右侧面板的
 * 文件树要画的**是同一件事**——同一个 `report.docx` 在产物卡片上和在文件树里不该是两枚
 * 不同的图形——所以把它抽到 `model/` 这一层，两个调用点共用一份（抄两份的话，
 * "给 `.pptx` 换一枚图标"就要记得改两处，而漏掉的那一处谁也不会发现）。
 *
 * 判据仍然是**后缀**而不是后端的 `file.format`：`format` 是渲染器那一档
 * （`docx` / `pdf` / `pptx`），而后缀才是"这份文件长什么样"。认不出来的一律给文档
 * 那一枚——不猜、也不留空。
 *
 * `fileIconFor` 与 `<FileTypeIcon/>` 是同一份判据的两面：文件树自己拼 `size` 要取函数，
 * 卡片里按调用点的尺寸渲染要取组件。放在这里是因为**两条路必须走同一张表**。
 */
import {
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Presentation,
  type LucideIcon,
} from 'lucide-react'

/** 后缀 → 图形。取不到的一律 `FileText`（见文件头注：不猜）。 */
export const ARTIFACT_ICONS: Record<string, LucideIcon> = {
  // 代码 / 数据：`</>` 与花括号
  js: FileCode2,
  jsx: FileCode2,
  ts: FileCode2,
  tsx: FileCode2,
  py: FileCode2,
  sh: FileTerminal,
  json: FileJson,
  yaml: FileCode2,
  yml: FileCode2,
  html: FileCode2,
  css: FileCode2,
  xml: FileCode2,
  // 表格
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  xls: FileSpreadsheet,
  // 幻灯
  pptx: Presentation,
  ppt: Presentation,
  // 图片
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  webp: FileImage,
  gif: FileImage,
  svg: FileImage,
}

/** 后缀归一：`'.PNG'` → `'png'`。 */
function normalize(format: string): string {
  return format.trim().toLowerCase().replace(/^\./, '')
}

/** 这一份文件的图形（`format` 可以是后缀，也可以是后端那个 `kind`）。 */
export function fileIconFor(format: string): LucideIcon {
  return ARTIFACT_ICONS[normalize(format)] ?? FileText
}

export function FileTypeIcon({ format, size = 18 }: { format: string; size?: number }) {
  const Icon = fileIconFor(format)
  return <Icon size={size} aria-hidden />
}
