// Índice da busca global (Ctrl+K): nomes dos objetos dos tipos mais comuns,
// carregados só com os metadados (PartialObjectMetadataList) para pesar pouco.

import { useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { ApiError, apiGet } from '@/lib/api'
import { collectionPath, kinds, type ResourceKind } from './catalog'
import { k8sKeys } from './queries'
import type { List, Pod } from './types'

/** Tipos cujos objetos a busca encontra pelo nome. */
export const SEARCH_KINDS: ResourceKind[] = [
  kinds.pods,
  kinds.deployments,
  kinds.statefulsets,
  kinds.daemonsets,
  kinds.jobs,
  kinds.cronjobs,
  kinds.services,
  kinds.ingresses,
  kinds.configmaps,
  kinds.secrets,
  kinds.pvcs,
  kinds.serviceaccounts,
  kinds.nodes,
  kinds.namespaces,
]

const METADATA_ACCEPT = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1, application/json'

export interface ObjectHit {
  kind: ResourceKind
  name: string
  namespace?: string
}

/** Nomes dos objetos do tipo em todos os namespaces; sem permissão, nenhum. */
export async function fetchNames(k: ResourceKind): Promise<ObjectHit[]> {
  try {
    const list = await apiGet<{ items?: { metadata: { name: string; namespace?: string } }[] }>(
      `/api/k8s${collectionPath(k, '')}`,
      { headers: { Accept: METADATA_ACCEPT } },
    )
    return (list.items ?? []).map((o) => ({ kind: k, name: o.metadata.name, namespace: o.metadata.namespace }))
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return []
    throw e
  }
}

/** Minúsculas e sem acentos, para comparar o que foi digitado. */
export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/**
 * Objetos cujo nome contém o termo, do mais relevante ao menos: nome igual,
 * depois começando pelo termo, depois contendo; empate pelo nome mais curto.
 */
export function matchObjects(hits: ObjectHit[], term: string, limit = 20): ObjectHit[] {
  const q = normalize(term.trim())
  if (!q) return []
  const scored: [number, ObjectHit][] = []
  for (const h of hits) {
    const n = h.name.toLowerCase()
    const i = n.indexOf(q)
    if (i < 0) continue
    scored.push([n === q ? 0 : i === 0 ? 1 : 2, h])
  }
  return scored
    .sort(([a, x], [b, y]) => a - b || x.name.length - y.name.length || x.name.localeCompare(y.name))
    .slice(0, limit)
    .map(([, h]) => h)
}

/**
 * Nomes dos objetos do tipo. Os pods de todos os namespaces podem já estar no
 * cache (Visão geral, lista de pods): reaproveitá-los evita baixar de novo os
 * metadados de milhares de pods.
 */
export function namesFor(k: ResourceKind, qc: QueryClient): Promise<ObjectHit[]> {
  const pods = k.id === 'pods' ? qc.getQueryData<List<Pod>>(k8sKeys.pods('')) : undefined
  if (pods) return Promise.resolve(pods.items.map((p) => ({ kind: k, name: p.metadata.name, namespace: p.metadata.namespace })))
  return fetchNames(k)
}

/** Índice de nomes; só consulta o cluster enquanto `enabled` (paleta aberta). */
export function useSearchIndex(enabled: boolean) {
  const qc = useQueryClient()
  return useQueries({
    queries: SEARCH_KINDS.map((k) => ({
      queryKey: ['k8s', 'search-names', k.id],
      queryFn: () => namesFor(k, qc),
      enabled,
      staleTime: 30_000,
    })),
    combine: (results) => ({
      hits: results.flatMap((r) => r.data ?? []),
      loading: results.some((r) => r.isPending && r.fetchStatus === 'fetching'),
    }),
  })
}
