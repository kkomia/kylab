/**
 * 404 页（旧 `views/NotFoundView.vue`）的用例。
 *
 * 原先这一份是「登录页 + 404」（`tests/misc-auth.test.tsx`）：登录页 2026-10-08 删了
 * （本机档免登录，见 `app/App.tsx` 的文件头），所以只剩 404 这一半，文件跟着改名。
 *
 * 两条与"路走到这里就没有下一句"直接相关的口径：
 * 1. **只有一句标题**，两个出口（回顾览 / 退回上一页）——同一件事不写两行；
 * 2. 「返回上一页」真的按路由历史往回退。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'

import { NotFoundPage } from '@/features/misc/auth/NotFoundPage'
import { renderMisc } from '@/features/misc/testing/harness'

describe('404', () => {
  it('一句标题 + 两个出口，不再有第二行同义标题', () => {
    renderMisc(<NotFoundPage />)

    expect(screen.getByRole('heading', { name: '页面不存在' })).toBeInTheDocument()
    // 原来那句空态标题「没有找到这个地址」与页标题说同一件事：合并之后不再出现
    expect(screen.queryByText('没有找到这个地址')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '回到概览' })).toHaveAttribute('href', '/')
    // 第二条出路：从哪儿点错的就退回哪儿
    expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument()
  })

  it('「返回上一页」真的退回上一个地址', async () => {
    render(
      <MemoryRouter initialEntries={['/', '/no-such-page']} initialIndex={1}>
        <Routes>
          <Route path="/" element={<div>概览页</div>} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByRole('button', { name: '返回上一页' }))
    expect(await screen.findByText('概览页')).toBeInTheDocument()
  })
})
