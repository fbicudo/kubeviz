// Métricas de CPU e memória ao vivo (metrics-server, API metrics.k8s.io),
// comparadas com requests, limits e a capacidade alocável dos nós.

import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'
import { k8sGet } from './queries'
import type { Node, Pod } from './types'

/** O metrics-server atualiza a cada ~15 s. */
export const METRICS_REFRESH_MS = 15_000

export interface NodeMetrics {
  metadata: { name: string }
  timestamp: string
  window: string
  usage: { cpu: string; memory: string }
}

export interface PodMetrics {
  metadata: { name: string; namespace: string }
  timestamp: string
  containers: { name: string; usage: { cpu: string; memory: string } }[]
}

const SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
}

/** Quantidade do Kubernetes ("250m", "1.5", "128Mi", "1e3") em unidades base. */
export function parseQuantity(q: string | undefined): number {
  if (!q) return 0
  const m = /^([+-]?[0-9.]+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(q.trim())
  if (!m || !(m[2] in SUFFIX)) return 0
  return Number(m[1]) * SUFFIX[m[2]]
}

/** CPU em milicores. */
export const cpuMillis = (q: string | undefined) => parseQuantity(q) * 1000

/** CPU para leitura: milicores abaixo de 1 núcleo ("152m"), núcleos acima ("1.5 CPU"). */
export function formatCpu(millis: number): string {
  if (millis < 1000) return `${Math.round(millis)}m`
  return `${Number((millis / 1000).toFixed(millis < 10_000 ? 2 : 1))} CPU`
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Uso e reservas de CPU (milicores) e memória (bytes). */
export interface Usage {
  cpu: number
  memory: number
  cpuRequests: number
  memoryRequests: number
  cpuLimits: number
  memoryLimits: number
}

const emptyUsage = (): Usage => ({ cpu: 0, memory: 0, cpuRequests: 0, memoryRequests: 0, cpuLimits: 0, memoryLimits: 0 })

/** Requests e limits somados dos containers do pod (só pods ativos reservam). */
export function podReservations(pod: Pod): Pick<Usage, 'cpuRequests' | 'memoryRequests' | 'cpuLimits' | 'memoryLimits'> {
  const out = { cpuRequests: 0, memoryRequests: 0, cpuLimits: 0, memoryLimits: 0 }
  if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') return out
  for (const c of pod.spec.containers) {
    out.cpuRequests += cpuMillis(c.resources?.requests?.cpu)
    out.memoryRequests += parseQuantity(c.resources?.requests?.memory)
    out.cpuLimits += cpuMillis(c.resources?.limits?.cpu)
    out.memoryLimits += parseQuantity(c.resources?.limits?.memory)
  }
  return out
}

const podKey = (ns: string | undefined, name: string) => `${ns ?? ''}/${name}`

/** Uso atual de cada pod (soma dos containers). */
export function podUsageIndex(metrics: PodMetrics[]): Map<string, { cpu: number; memory: number }> {
  const out = new Map<string, { cpu: number; memory: number }>()
  for (const m of metrics) {
    let cpu = 0
    let memory = 0
    for (const c of m.containers) {
      cpu += cpuMillis(c.usage.cpu)
      memory += parseQuantity(c.usage.memory)
    }
    out.set(podKey(m.metadata.namespace, m.metadata.name), { cpu, memory })
  }
  return out
}

export interface Workload {
  kind: string
  name: string
  namespace: string
}

/**
 * Workload dono do pod. Pods de Deployment pertencem a um ReplicaSet chamado
 * "<deployment>-<pod-template-hash>": o hash é tirado do nome. Pods estáticos
 * aparecem como eles mesmos (cada um é um componente diferente).
 */
export function workloadOf(pod: Pod): Workload {
  const ns = pod.metadata.namespace ?? ''
  const owner = pod.metadata.ownerReferences?.find((o) => o.controller) ?? pod.metadata.ownerReferences?.[0]
  // Sem dono, ou pod estático (o "dono" é o nó: apiserver, etcd…): o próprio pod.
  if (!owner || owner.kind === 'Node') return { kind: 'Pod', name: pod.metadata.name, namespace: ns }
  const hash = pod.metadata.labels?.['pod-template-hash']
  if (owner.kind === 'ReplicaSet' && hash && owner.name.endsWith(`-${hash}`)) {
    return { kind: 'Deployment', name: owner.name.slice(0, -hash.length - 1), namespace: ns }
  }
  return { kind: owner.kind, name: owner.name, namespace: ns }
}

export interface PodRow extends Usage {
  pod: Pod
  workload: Workload
  /** Sem amostra do metrics-server (pod recém-criado ou parado). */
  measured: boolean
}

/** Pods com uso e reservas. */
export function podRows(pods: Pod[], metrics: PodMetrics[]): PodRow[] {
  const usage = podUsageIndex(metrics)
  return pods.map((pod) => {
    const u = usage.get(podKey(pod.metadata.namespace, pod.metadata.name))
    return { ...emptyUsage(), ...podReservations(pod), cpu: u?.cpu ?? 0, memory: u?.memory ?? 0, pod, workload: workloadOf(pod), measured: !!u }
  })
}

export interface GroupRow extends Usage {
  key: string
  pods: number
}

/** Soma o uso dos pods por uma chave (namespace, workload…). */
export function groupBy(rows: PodRow[], key: (r: PodRow) => string): GroupRow[] {
  const out = new Map<string, GroupRow>()
  for (const r of rows) {
    const k = key(r)
    const g = out.get(k) ?? { ...emptyUsage(), key: k, pods: 0 }
    g.cpu += r.cpu
    g.memory += r.memory
    g.cpuRequests += r.cpuRequests
    g.memoryRequests += r.memoryRequests
    g.cpuLimits += r.cpuLimits
    g.memoryLimits += r.memoryLimits
    g.pods++
    out.set(k, g)
  }
  return [...out.values()]
}

export interface NodeRow extends Usage {
  node: Node
  cpuAllocatable: number
  memoryAllocatable: number
  pods: number
  measured: boolean
}

/** Nós com uso, capacidade alocável e reservas dos pods agendados neles. */
export function nodeRows(nodes: Node[], metrics: NodeMetrics[], pods: PodRow[]): NodeRow[] {
  const usage = new Map(metrics.map((m) => [m.metadata.name, m.usage]))
  const byNode = new Map(groupBy(pods.filter((p) => p.pod.spec.nodeName), (p) => p.pod.spec.nodeName!).map((g) => [g.key, g]))
  return nodes.map((node) => {
    const u = usage.get(node.metadata.name)
    const g = byNode.get(node.metadata.name)
    return {
      node,
      cpu: cpuMillis(u?.cpu),
      memory: parseQuantity(u?.memory),
      cpuRequests: g?.cpuRequests ?? 0,
      memoryRequests: g?.memoryRequests ?? 0,
      cpuLimits: g?.cpuLimits ?? 0,
      memoryLimits: g?.memoryLimits ?? 0,
      cpuAllocatable: cpuMillis(node.status.allocatable?.cpu),
      memoryAllocatable: parseQuantity(node.status.allocatable?.memory),
      pods: g?.pods ?? 0,
      measured: !!u,
    }
  })
}

/** Estado da fonte de métricas: ausente (sem metrics-server) ou sem permissão. */
export type MetricsUnavailable = 'missing' | 'forbidden' | 'error'

export function metricsProblem(error: unknown): MetricsUnavailable {
  if (error instanceof ApiError && error.status === 404) return 'missing'
  if (error instanceof ApiError && error.status === 403) return 'forbidden'
  return 'error'
}

const retryUnlessClientError = (count: number, error: Error) => !(error instanceof ApiError && error.status < 500) && count < 1

export function useNodeMetrics() {
  return useQuery({
    queryKey: ['k8s', 'metrics', 'nodes'],
    queryFn: () => k8sGet<{ items: NodeMetrics[] }>('/apis/metrics.k8s.io/v1beta1/nodes'),
    refetchInterval: METRICS_REFRESH_MS,
    retry: retryUnlessClientError,
  })
}

export function usePodMetrics(namespace: string) {
  const path = namespace
    ? `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods`
    : '/apis/metrics.k8s.io/v1beta1/pods'
  return useQuery({
    queryKey: ['k8s', 'metrics', 'pods', namespace],
    queryFn: () => k8sGet<{ items: PodMetrics[] }>(path),
    refetchInterval: METRICS_REFRESH_MS,
    retry: retryUnlessClientError,
  })
}

/** Tipos com aba Métricas: os workloads que o histórico agrupa, pods e nós. */
export const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job'])
export const hasMetricsTab = (kind: string) => kind === 'Pod' || kind === 'Node' || WORKLOAD_KINDS.has(kind)
