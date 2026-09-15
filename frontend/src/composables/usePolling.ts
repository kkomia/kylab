/**
 * 轮询（§12.116）：页面里所有"每隔 N 秒刷一次"的地方都走它。
 *
 * 之前四处各写一份 `setInterval`（知识库列表、任务中心、Wiki、抽屉明细），
 * 于是三个问题在四个地方各犯一遍：
 *
 * 1. **标签页看不见时照打**：把页面切到后台过夜，浏览器仍然每 2 秒发一次请求
 *    （一晚约 4 万次），而用户一个字也看不到。→ 隐藏时暂停，**回来时立刻刷一次**
 *    （这样"切回来看到的是旧数据"也不会发生）。
 * 2. **慢请求会堆积**：`setInterval` 不看上一轮结束没结束，后端一旦慢下来，
 *    请求就一层层叠上去，越慢越慢。→ 在飞时跳过这一拍。
 * 3. **每处都自己管生命周期**：忘了解绑、忘了在条件变化时停表，这类 bug 在
 *    四个副本里迟早出现一次。→ 收在一处，`watch` 由它自己管。
 *
 * 刻意**不用 `setTimeout` 递归**：那会让"间隔"等于"间隔 + 请求耗时"，
 * 而进度条要的是稳定的刷新节奏（两秒一跳读起来才像在动）。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** 页面是否可见。SSR/测试环境里没有 `document`，默认当作可见。 */
function isVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

export interface PollingOptions {
  /** 只在它为真时轮询（如"有任务在跑"）。 */
  active: Ref<boolean>
  /** 间隔毫秒数。默认 2000——与进度条、时间线的刷新节奏一致。 */
  intervalMs?: number
  /** 立刻执行一次（挂载时先取数据，别等第一个间隔）。 */
  immediate?: boolean
}

export function usePolling(task: () => void | Promise<void>, options: PollingOptions): void {
  const { active, intervalMs = 2000, immediate = true } = options
  const visible = ref(isVisible())
  let timer: ReturnType<typeof setInterval> | null = null
  /** 上一轮还没回来：跳过这一拍，别把请求叠起来。 */
  let inFlight = false

  async function tick(): Promise<void> {
    if (inFlight) return
    inFlight = true
    try {
      await task()
    } finally {
      inFlight = false
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function start(): void {
    if (timer !== null) return
    timer = setInterval(() => void tick(), intervalMs)
  }

  function sync(): void {
    if (active.value && visible.value) start()
    else stop()
  }

  function onVisibilityChange(): void {
    const nowVisible = isVisible()
    const wasVisible = visible.value
    visible.value = nowVisible
    sync()
    // 切回来时**立刻刷一次**：否则用户要盯着一个最多 2 秒前的画面，
    // 而那 2 秒里他刚做过的事（比如点了重新摄入）看不到任何反应
    if (nowVisible && !wasVisible && active.value) void tick()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  watch(active, (value) => {
    sync()
    if (value && immediate) void tick()
  })

  if (active.value && immediate) void tick()
  sync()

  onBeforeUnmount(() => {
    stop()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })
}
