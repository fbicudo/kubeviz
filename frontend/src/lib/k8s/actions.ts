// Ações sobre objetos (escalar, reiniciar, pausar, rollback, cordon, excluir)
// e verificação de permissão com SelfSubjectAccessReview.

import { useQuery } from '@tanstack/react-query'
import { ApplyError, FIELD_MANAGER } from './apply'
import type { K8sObject } from './types'

export interface AccessCheck {
  verb: string
  group: string
  resource: string
  subresource?: string
  namespace?: string
  name?: string
}

/** Pergunta ao cluster se o usuário atual pode fazer a operação. */
export async function canI(c: AccessCheck): Promise<boolean> {
  const res = await fetch('/api/k8s/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: { resourceAttributes: c },
    }),
  })
  if (!res.ok) return false
  const body = (await res.json()) as { status?: { allowed?: boolean } }
  return body.status?.allowed === true
}

/** Várias verificações de uma vez; enquanto carrega, nada é permitido. */
export function useCan<K extends string>(checks: Record<K, AccessCheck>): Partial<Record<K, boolean>> {
  const key = JSON.stringify(checks)
  const q = useQuery({
    queryKey: ['k8s', 'can', key],
    queryFn: async () => {
      const entries = Object.entries(checks) as [K, AccessCheck][]
      const results = await Promise.all(entries.map(([, c]) => canI(c)))
      return Object.fromEntries(entries.map(([k], i) => [k, results[i]])) as Record<K, boolean>
    },
    staleTime: 60_000,
  })
  return q.data ?? {}
}

type PatchType = 'merge' | 'strategic' | 'json'
const CONTENT_TYPE: Record<PatchType, string> = {
  merge: 'application/merge-patch+json',
  strategic: 'application/strategic-merge-patch+json',
  json: 'application/json-patch+json',
}

async function send(method: string, url: string, body?: unknown, contentType?: string): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string; reason?: string }
  if (!res.ok) throw new ApplyError(res.status, data.message ?? data.error ?? res.statusText, data.reason)
  return data
}

/** PATCH com o KubeViz registrado como gerenciador dos campos. */
export function patchObject(path: string, body: unknown, type: PatchType) {
  return send('PATCH', `/api/k8s${path}?fieldManager=${FIELD_MANAGER}`, body, CONTENT_TYPE[type])
}

/**
 * Exclui o objeto; os dependentes (pods de um ReplicaSet…) são removidos em
 * segundo plano. As opções vão no corpo (DeleteOptions em JSON): o backend
 * exige JSON em todo pedido que altera o cluster (proteção contra CSRF).
 */
export function deleteObject(path: string) {
  return send('DELETE', `/api/k8s${path}`, { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Background' }, 'application/json')
}

export const scaleBody = (replicas: number) => ({ spec: { replicas } })

/** Mesmo mecanismo do `kubectl rollout restart`: muda uma anotação do template. */
export const restartBody = (now = new Date()) => ({
  spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': now.toISOString() } } } },
})

export const pauseBody = (paused: boolean) => ({ spec: { paused } })

export const cordonBody = (unschedulable: boolean) => ({ spec: { unschedulable } })

export const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision'

export interface Revision {
  revision: number
  replicaSet: K8sObject
  images: string[]
  current: boolean
}

/** Revisões de um Deployment, a partir dos ReplicaSets que pertencem a ele. */
export function deploymentRevisions(deployment: K8sObject, replicaSets: K8sObject[]): Revision[] {
  const current = Number(deployment.metadata.annotations?.[REVISION_ANNOTATION] ?? 0)
  return replicaSets
    .filter((rs) => rs.metadata.ownerReferences?.some((o) => o.uid === deployment.metadata.uid))
    .map((rs) => {
      const tpl = (rs.spec as { template?: { spec?: { containers?: { image?: string }[] } } })?.template
      return {
        revision: Number(rs.metadata.annotations?.[REVISION_ANNOTATION] ?? 0),
        replicaSet: rs,
        images: (tpl?.spec?.containers ?? []).map((c) => c.image ?? ''),
        current: Number(rs.metadata.annotations?.[REVISION_ANNOTATION] ?? 0) === current,
      }
    })
    .sort((a, b) => b.revision - a.revision)
}

/**
 * Patch de rollback (como `kubectl rollout undo --to-revision`): troca o
 * template do Deployment pelo do ReplicaSet da revisão, sem o rótulo
 * pod-template-hash, que é do ReplicaSet.
 */
export function rollbackPatch(rs: K8sObject) {
  const template = structuredClone((rs.spec as { template: { metadata?: { labels?: Record<string, string> } } }).template)
  if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash']
  return [{ op: 'replace', path: '/spec/template', value: template }]
}
