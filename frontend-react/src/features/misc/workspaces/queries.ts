/**
 * 工作区的 query key（一处定义，别处只引用）。
 *
 * 抽出来的理由很具体：新建弹窗、页面、目录选择器都会失效同一份缓存，
 * key 字面量写在三处就一定会漂一处，而"漂了"的表现是**列表不刷新**——
 * 那种 bug 只在手动操作时出现，测试很难兜住。
 */
export const WORKSPACES_QUERY_KEY = ['workspaces', 'list'] as const
