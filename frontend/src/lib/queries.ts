import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getCluster, getContexts, getSession, login, logout, setCurrentContext } from './api'

export const sessionKey = ['session'] as const

export const clusterKeys = {
  info: ['cluster'] as const,
  contexts: ['contexts'] as const,
}

export function useSession() {
  return useQuery({ queryKey: sessionKey, queryFn: getSession, staleTime: 60_000 })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: login,
    onSuccess: (session) => qc.setQueryData(sessionKey, session),
  })
}

/** Encerra a sessão e descarta todos os dados em cache. */
export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSettled: () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] })
      void qc.invalidateQueries({ queryKey: sessionKey })
    },
  })
}

/** Estado da conexão; reconsultado a cada 30 s para refletir quedas. */
export function useClusterInfo() {
  return useQuery({ queryKey: clusterKeys.info, queryFn: getCluster, refetchInterval: 30_000 })
}

export function useContexts() {
  return useQuery({ queryKey: clusterKeys.contexts, queryFn: getContexts })
}

/** Troca o contexto ativo e descarta todos os dados do cluster anterior. */
export function useSwitchContext() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: setCurrentContext,
    onSuccess: (info) => {
      qc.setQueryData(clusterKeys.info, info)
      void qc.invalidateQueries()
    },
  })
}
