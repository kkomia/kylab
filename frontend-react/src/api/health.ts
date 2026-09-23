/** 服务存活探针接口（对应后端 GET /api/v1/health）。 */

import { request } from './client'

export interface HealthResponse {
  status: string
  app: string
  version: string
  api_version: string
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}
