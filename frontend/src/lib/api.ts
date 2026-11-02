/** Erro devolvido pela API do Kubora (`{"error": "..."}`). */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init)
}

export async function apiSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown): Promise<T> {
  // O backend exige JSON em requisições que alteram estado (proteção CSRF).
  return request<T>(path, {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...init?.headers } })
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: string }).error ?? message
    } catch {
      // corpo não é JSON
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

export interface VersionInfo {
  version: string
  commit: string
  date: string
  goVersion: string
}

export const getVersion = () => apiGet<VersionInfo>('/api/v1/version')

export type ClusterMode = 'local' | 'in-cluster'

export interface ClusterInfo {
  mode: ClusterMode
  context?: string
  server: string
  reachable: boolean
  version?: string
  platform?: string
  error?: string
}

export interface ContextInfo {
  name: string
  cluster: string
  user: string
  namespace?: string
  current: boolean
}

export const getCluster = () => apiGet<ClusterInfo>('/api/v1/cluster')

export const getContexts = () =>
  apiGet<{ mode: ClusterMode; contexts: ContextInfo[] }>('/api/v1/contexts')

export const setCurrentContext = (name: string) =>
  apiSend<ClusterInfo>('PUT', '/api/v1/contexts/current', { name })
