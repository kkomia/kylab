/**
 * 404 页：地址拼错时给一个明确出口，而不是空白。
 * ——与旧前端 `views/NotFoundView.vue` 对应（观感取同一套：限宽正文列 + 页标题）。
 */
import { Link } from 'react-router'

import { Button } from '@/ui/button'
import { EmptyState } from '../shared/composites'

export function NotFoundPage() {
  return (
    <article className="page-shell page-shell-narrow">
      <header className="m-page-head">
        <h1 className="m-page-title">页面不存在</h1>
      </header>
      <div className="page-shell-body">
        <EmptyState title="没有找到这个地址" hint="链接可能已失效，或者知识库/文档已经被删除。">
          {/* 主按钮样式的链接：`Button asChild` 把类名给到 `<a>` 本身，
              而不是在 `<a>` 里再套一个按钮（那样是无障碍上的嵌套交互元素） */}
          <Button asChild>
            <Link to="/">回到概览</Link>
          </Button>
        </EmptyState>
      </div>
    </article>
  )
}
