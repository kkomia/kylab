/**
 * `@vue-office/*` 的类型声明。
 *
 * 这两个包的 `package.json` 没有 `types` 字段（类型文件 `lib/index.d.ts` 存在，
 * 但没被指向），TS 找不到声明就会把 import 判成 any 报错。这里按它们的
 * `src` / `options` 协议手写一份最小声明——**只声明我们真正用到的部分**。
 *
 * 运行时入口由 `vite.config.ts` 的别名指到 `lib/v3/index.js`（Vue 3 构建）。
 */
declare module '@vue-office/excel' {
  import type { DefineComponent } from 'vue'

  interface ExcelOptions {
    minColLength?: number
    minRowLength?: number
    showContextmenu?: boolean
  }

  const VueOfficeExcel: DefineComponent<{
    src?: string | ArrayBuffer | Blob
    options?: ExcelOptions
  }>

  export default VueOfficeExcel
}

declare module '@vue-office/pptx' {
  import type { DefineComponent } from 'vue'

  const VueOfficePptx: DefineComponent<{
    src?: string | ArrayBuffer | Blob
  }>

  export default VueOfficePptx
}
