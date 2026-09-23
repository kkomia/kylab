/**
 * 应用壳（P0 占位版）：**只做一件事**——把 Provider 与路由装起来。
 *
 * P2 阶段这里会长成完整的壳（会话恢复、侧栏导航、主题/字号、Toast、错误页）；
 * 现在先立住"入口 + Provider + 路由"这三件骨架，让各域的页面可以各自挂上来。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import { ChatPage } from '@/features/chat/ChatPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 后端是自托管的局域网服务，失败多半是"服务没起来"或"令牌过期"，
      // 重试两次足够让一次抖动自愈，再多只是让用户多等（旧前端的口径一致）
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/chat/:conversationId?" element={<ChatPage />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
