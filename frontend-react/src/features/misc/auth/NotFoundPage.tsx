/**
 * 404 页：地址拼错时给一个明确出口，而不是空白。
 * ——与旧前端 `views/NotFoundView.vue` 对应（观感取同一套：限宽正文列 + 页标题）。
 */
import { Link } from 'react-router'

import { EmptyState } from '../shared/ui'

export function NotFoundPage() {
  return (
    <article className="page-shell page-shell-narrow">
      <header className="m-page-head">
        <h1 className="m-page-title">页面不存在</h1>
      </header>
      <div className="page-shell-body">
        <EmptyState title="没有找到这个地址" hint="链接可能已失效，或者知识库/文档已经被删除。">
          <Link to="/">
            <span className="m-btn m-btn-primary">回到概览</span>
          </Link>
        </EmptyState>
      </div>
    </article>
  )
}
