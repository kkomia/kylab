import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { App } from '@/app/App'

describe('脚手架', () => {
  it('能挂载应用壳并渲染对话页占位', () => {
    render(<App />)

    expect(screen.getByText(/React 前端脚手架已就绪/)).toBeInTheDocument()
  })
})
