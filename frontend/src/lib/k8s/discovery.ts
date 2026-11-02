// Descoberta dos tipos que o cluster conhece (inclusive CRDs), pela
// descoberta agregada da API (apidiscovery.k8s.io/v2, Kubernetes 1.30+):
// duas chamadas (/api e /apis) trazem todos os grupos, versões e recursos.

import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/lib/api'
import type { ResourceKind } from './catalog'

const DISCOVERY_ACCEPT = 'application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json'

interface DiscoveryResource {
  resource: string
  scope: 'Namespaced' | 'Cluster'
  responseKind?: { kind: string }
  verbs?: string[]
}

interface DiscoveryList {
  kind: string
  items: { metadata: { name?: string }; versions: { version: string; resources?: DiscoveryResource[] }[] }[]
}

/** Tipos do cluster indexados por "apiVersion/Kind" (ex.: "apps/v1/Deployment"). */
export type Discovery = Map<string, ResourceKind>

export const discoveryKey = (apiVersion: string, kind: string) => `${apiVersion}/${kind}`

/** Converte as respostas de /api e /apis no índice de tipos. */
export function parseDiscovery(lists: DiscoveryList[]): Discovery {
  const out: Discovery = new Map()
  for (const list of lists) {
    if (list.kind !== 'APIGroupDiscoveryList') {
      throw new Error('o cluster não oferece a descoberta agregada da API (Kubernetes 1.30 ou mais novo)')
    }
    for (const g of list.items) {
      const group = g.metadata.name ?? ''
      for (const v of g.versions) {
        const apiVersion = group ? `${group}/${v.version}` : v.version
        for (const r of v.resources ?? []) {
          const kind = r.responseKind?.kind
          if (!kind) continue
          const key = discoveryKey(apiVersion, kind)
          // Primeiro recurso que devolve o tipo (ignora subrecursos e aliases).
          if (!out.has(key)) {
            out.set(key, {
              id: r.resource,
              kind,
              group,
              version: v.version,
              resource: r.resource,
              namespaced: r.scope === 'Namespaced',
            })
          }
        }
      }
    }
  }
  return out
}

/** Tipo descoberto a partir do grupo, versão e recurso (como na URL da API). */
export function findByResource(d: Discovery, group: string, version: string, resource: string): ResourceKind | undefined {
  for (const k of d.values()) if (k.group === group && k.version === version && k.resource === resource) return k
  return undefined
}

export async function fetchDiscovery(): Promise<Discovery> {
  const opts = { headers: { Accept: DISCOVERY_ACCEPT } }
  const [core, groups] = await Promise.all([
    apiGet<DiscoveryList>('/api/k8s/api', opts),
    apiGet<DiscoveryList>('/api/k8s/apis', opts),
  ])
  return parseDiscovery([core, groups])
}

/** Índice de tipos do cluster; muda pouco, então fica 5 minutos em cache. */
export function useDiscovery() {
  return useQuery({ queryKey: ['k8s', 'discovery'], queryFn: fetchDiscovery, staleTime: 5 * 60_000 })
}
