/**
 * 上传约束（前端侧的一份）。
 *
 * **为什么要有这个文件**：这些数字与清单以前散在三处——上传弹窗里的提示、空状态里的
 * 说明、以及各自写死的 `200 * 1024 * 1024`。改一处漏一处的后果不是崩溃，而是
 * **界面上两句话互相矛盾**（一边说上限 200MB、一边说 100MB），用户只能靠试。
 *
 * 与旧前端 `composables/uploadLimits.ts` 取值逐条一致（`MAX_UPLOAD_BYTES` 对齐后端
 * `app/api/v1/documents.py` 的 `MAX_UPLOAD_BYTES`）。**放这里而不是 `src/lib/`**：
 * 本域不能写 `src/lib/**`（那是主控的文件）；等它在那儿落地后，把这份删掉改引它即可。
 */

/** 单文件上限，与后端 `MAX_UPLOAD_BYTES` 对齐：云端解析的单文件上限。 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

/** 给文案用的整数 MB，避免每个地方各写一个 200。 */
export const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))

/**
 * 一次最多几个文件。与 MaxKB 的"每次最多 50 个"同档——
 * 这是业界已经在用的量级，不必另发明一个；再多也只会让清单长到没人看得完。
 */
export const MAX_UPLOAD_FILES = 50

/**
 * 支持的格式，一句话说清。
 *
 * 不逐条罗列扩展名：用户认的是"Word 能不能传"，而不是".docx 在不在白名单里"。
 * **也不写"扫描件走 OCR 渠道"这类解析链路的说明**：用户要决定的是"这个文件能不能传"。
 */
export const UPLOAD_FORMAT_HINT = '支持 PDF、Word、PPT、Excel、Markdown、纯文本、CSV 与图片'
