// Administração das contas locais e dos provedores de login (só administradores).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiSend } from './api'
import { sessionKey } from './queries'

export interface Account {
  name: string
  admin: boolean
  hasPassword: boolean
  emails: string[]
  created?: string
  /** A conta da sessão atual. */
  current?: boolean
}

export interface AccountsResponse {
  accounts: Account[]
  allowedDomains: string[]
}

export interface AccountRequest {
  name?: string
  password?: string
  removePassword?: boolean
  admin?: boolean
  emails?: string[]
}

export type ProviderType = 'google' | 'microsoft' | 'github' | 'oidc'

export interface Provider {
  id: string
  type: ProviderType
  name: string
  clientId: string
  hasSecret: boolean
  issuerUrl?: string
  tenant?: string
}

export interface ProviderRequest {
  type: ProviderType
  name?: string
  clientId: string
  /** Vazio mantém o secret atual. */
  clientSecret?: string
  issuerUrl?: string
  tenant?: string
}

const accountsKey = ['admin', 'accounts'] as const
const providersKey = ['admin', 'providers'] as const

export function useAccounts() {
  return useQuery({ queryKey: accountsKey, queryFn: () => apiGet<AccountsResponse>('/api/v1/admin/users') })
}

export function useProviders() {
  return useQuery({ queryKey: providersKey, queryFn: () => apiGet<{ providers: Provider[] }>('/api/v1/admin/providers') })
}

/** Mutação que recarrega as contas (e a sessão: papéis e botões de login podem mudar). */
function useAdminMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
      void qc.invalidateQueries({ queryKey: sessionKey })
    },
  })
}

export const useCreateAccount = () => useAdminMutation((a: AccountRequest) => apiSend('POST', '/api/v1/admin/users', a))
export const useUpdateAccount = () =>
  useAdminMutation(({ name, ...changes }: AccountRequest & { name: string }) =>
    apiSend('PUT', `/api/v1/admin/users/${encodeURIComponent(name)}`, changes),
  )
export const useDeleteAccount = () => useAdminMutation((name: string) => apiSend('DELETE', `/api/v1/admin/users/${encodeURIComponent(name)}`, {}))
export const useSetDomains = () => useAdminMutation((domains: string[]) => apiSend('PUT', '/api/v1/admin/domains', { domains }))
export const useSaveProvider = () =>
  useAdminMutation(({ id, ...p }: ProviderRequest & { id: string }) => apiSend('PUT', `/api/v1/admin/providers/${encodeURIComponent(id)}`, p))
export const useDeleteProvider = () => useAdminMutation((id: string) => apiSend('DELETE', `/api/v1/admin/providers/${encodeURIComponent(id)}`, {}))

/** Endereço de retorno a registrar no provedor (o mesmo que o servidor monta). */
export const callbackURL = (id: string) => `${window.location.origin}/auth/provider/${id}/callback`

/** O Google (e outros) recusam endereços IP no retorno do login. */
export const hostIsIP = () => /^(\d{1,3}\.){3}\d{1,3}$|^\[/.test(window.location.hostname)

/** Lista de e-mails ou domínios digitados (um por linha, vírgula ou espaço). */
export const splitList = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
