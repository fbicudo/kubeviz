import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/lib/api'
import { collectionPath, type ResourceKind } from './catalog'
import type { List, Namespace, Node, Pod, Table } from './types'

/** Chamada à API do Kubernetes pelo proxy autenticado do KubeViz. */
export const k8sGet = <T>(path: string) => apiGet<T>(`/api/k8s${path}`)

/** Até o watch em tempo real (Fase 1), as listas são reconsultadas a cada 10 s. */
const REFRESH_MS = 10_000

/** Pede a resposta no formato Table; o cluster define as colunas. */
const TABLE_ACCEPT = 'application/json;as=Table;v=v1;g=meta.k8s.io, application/json'

export const k8sKeys = {
  table: (kindId: string, namespace: string) => ['k8s', 'table', kindId, namespace] as const,
  pods: (namespace: string) => ['k8s', 'pods', namespace] as const,
  namespaces: ['k8s', 'namespaces'] as const,
  nodes: ['k8s', 'nodes'] as const,
}

/** Pods de um namespace; namespace vazio = todos os namespaces. */
export function usePods(namespace: string) {
  const path = namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods` : '/api/v1/pods'
  return useQuery({
    queryKey: k8sKeys.pods(namespace),
    queryFn: () => k8sGet<List<Pod>>(path),
    refetchInterval: REFRESH_MS,
  })
}

export function useNamespaces() {
  return useQuery({
    queryKey: k8sKeys.namespaces,
    queryFn: () => k8sGet<List<Namespace>>('/api/v1/namespaces'),
    refetchInterval: 60_000,
  })
}

export function useNodes() {
  return useQuery({
    queryKey: k8sKeys.nodes,
    queryFn: () => k8sGet<List<Node>>('/api/v1/nodes'),
    refetchInterval: REFRESH_MS,
  })
}

/** Lista de qualquer tipo de recurso no formato Table. */
export function useResourceTable(kind: ResourceKind, namespace: string) {
  return useQuery({
    queryKey: k8sKeys.table(kind.id, kind.namespaced ? namespace : ''),
    queryFn: () => apiGet<Table>(`/api/k8s${collectionPath(kind, namespace)}`, { headers: { Accept: TABLE_ACCEPT } }),
    refetchInterval: REFRESH_MS,
  })
}
