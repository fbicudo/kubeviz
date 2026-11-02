/** Erro devolvido pela API do KubeViz (`{"error": "..."}`). */
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
      // Erros do KubeViz vêm em {"error"}; os da API do Kubernetes, em {"message"}.
      const body = (await res.json()) as { error?: string; message?: string }
      message = body.error ?? body.message ?? message
    } catch {
      // corpo não é JSON
    }
    throw new ApiError(res.status, message)
  }
  // 204, ou 201 sem corpo: nada a interpretar.
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
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

export interface User {
  username: string
  groups?: string[]
}

/** Como entrar: login corporativo (OIDC), link com token (modo local), usuário e senha, ou token do Kubernetes. */
export type LoginMethod = 'oidc' | 'link' | 'password' | 'token'

export interface SessionInfo {
  mode: ClusterMode
  authenticated: boolean
  loginMethods: LoginMethod[]
  /** Nome do provedor OIDC exibido no botão de login. */
  oidcName?: string
  /** Primeiro acesso: a tela de login cria a conta de administrador ("expired" = prazo acabou). */
  setup?: 'available' | 'expired'
  /** Botões de login por provedor (Google, Microsoft, GitHub, OIDC). */
  providers?: LoginProvider[]
  /** Pode gerenciar contas e provedores. */
  admin?: boolean
  user?: User
  /** Conta local usada no login por usuário e senha. */
  localUser?: string
  expiresAt?: string
  userError?: string
}

export const getSession = () => apiGet<SessionInfo>('/api/v1/auth/session')

export const login = (token: string) => apiSend<SessionInfo>('POST', '/api/v1/auth/login', { token })

export interface LoginProvider {
  id: string
  type: 'google' | 'microsoft' | 'github' | 'oidc'
  name: string
}

/** Primeiro acesso: cria a conta de administrador e já entra com ela. */
export const setupAdmin = (username: string, password: string) =>
  apiSend<SessionInfo>('POST', '/api/v1/auth/setup', { username, password })

export const passwordLogin = (username: string, password: string) =>
  apiSend<SessionInfo>('POST', '/api/v1/auth/password', { username, password })

export const logout = () => apiSend<void>('POST', '/api/v1/auth/logout', {})
