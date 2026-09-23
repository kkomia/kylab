/**
 * 提示（成功 / 失败 / 警告）的唯一出口。
 *
 * 旧前端的 `useToast` 是自研的 48 行（挂一个 ref 数组再渲染），迁移计划 §2 直接换成
 * **sonner**（成熟库，来去动画、堆叠、自动消失都不必自己写）。这里包一层是为了
 * "吐司库换了"只改一个文件，以及**三档语义**（成功/失败/警告）在界面各处叫法一致。
 */
import { toast } from 'sonner'

export function notifySuccess(message: string): void {
  toast.success(message)
}

export function notifyWarning(message: string): void {
  toast.warning(message)
}

/** 失败一律用它：文案取后端/异常里的中文原因，不自己编一句（旧前端同一条）。 */
export function notifyError(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause || '操作失败')
  toast.error(message)
}
