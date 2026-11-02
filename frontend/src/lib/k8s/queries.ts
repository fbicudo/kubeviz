import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/lib/api'
import { collectionPath, type ResourceKind } from './catalog'
import type { List, Namespace, Node, Pod, Table } from './types'
import {
  applyListEvent,
  applyTableEvent,
  listResourceVersion,
  pollUnlessLive,
  tableResourceVersion,
  useWatch,
  type LiveState,
} from './watch'

/** Chamada à API do Kubernetes pelo proxy autenticado do KubeViz. */
export const k8sGet = <T>(path: string) => apiGet<T>(`/api/k8s${path}`)

/** Sem watch (ex.: sem permissão de watch), as listas são reconsultadas a cada 10 s. */
const REFRESH_MS = 10_000

/** Pede a resposta no formato Table; o cluster define as colunas. */
const TABLE_ACCEPT = 'application/json;as=Table;v=v1;g=meta.k8s.io, application/json'

export const k8sKeys = {
  table: (kindId: string, namespace: string) => ['k8s', 'table', kindId, namespace] as const,
  pods: (namespace: string) => ['k8s', 'pods', namespace] as const,
  namespaces: ['k8s', 'namespaces'] as const,
  nodes: ['k8s', 'nodes'] as const,
}

const podsPath = (namespace: string) =>
  namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods` : '/api/v1/pods'

/** Pods de um namespace; namespace vazio = todos os namespaces. */
export function usePods(namespace: string) {
  return useQuery({
    queryKey: k8sKeys.pods(namespace),
    queryFn: () => k8sGet<List<Pod>>(podsPath(namespace)),
    refetchInterval: pollUnlessLive(REFRESH_MS),
  })
}

/** Mantém a lista de pods atualizada por watch. */
export function usePodsLive(namespace: string, loaded: boolean): LiveState {
  return useWatch({
    queryKey: k8sKeys.pods(namespace),
    path: `/api/k8s${podsPath(namespace)}`,
    enabled: loaded,
    apply: applyListEvent<Pod>,
    resourceVersion: listResourceVersion<Pod>,
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
    refetchInterval: pollUnlessLive(REFRESH_MS),
  })
}

export function useNodesLive(loaded: boolean): LiveState {
  return useWatch({
    queryKey: k8sKeys.nodes,
    path: '/api/k8s/api/v1/nodes',
    enabled: loaded,
    apply: applyListEvent<Node>,
    resourceVersion: listResourceVersion,
  })
}

/** Lista de qualquer tipo de recurso no formato Table. */
export function useResourceTable(kind: ResourceKind, namespace: string) {
  return useQuery({
    queryKey: k8sKeys.table(kind.id, kind.namespaced ? namespace : ''),
    queryFn: () => apiGet<Table>(`/api/k8s${collectionPath(kind, namespace)}`, { headers: { Accept: TABLE_ACCEPT } }),
    refetchInterval: pollUnlessLive(REFRESH_MS),
  })
}

/** Mantém a tabela atualizada por watch (o watch também aceita o formato Table). */
export function useResourceTableLive(kind: ResourceKind, namespace: string, loaded: boolean): LiveState {
  return useWatch({
    queryKey: k8sKeys.table(kind.id, kind.namespaced ? namespace : ''),
    path: `/api/k8s${collectionPath(kind, namespace)}`,
    accept: TABLE_ACCEPT,
    enabled: loaded,
    apply: applyTableEvent,
    resourceVersion: tableResourceVersion,
  })
}
