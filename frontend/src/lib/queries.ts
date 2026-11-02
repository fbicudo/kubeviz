import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getCluster, getContexts, setCurrentContext } from './api'

export const clusterKeys = {
  info: ['cluster'] as const,
  contexts: ['contexts'] as const,
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
