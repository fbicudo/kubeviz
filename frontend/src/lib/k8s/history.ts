// Histórico de métricas (coletor embutido): consultas e preparação dos dados
// para os gráficos.

import { useQuery } from '@tanstack/react-query'
import { ApiError, apiGet } from '@/lib/api'

export type HistoryRange = '15m' | '1h' | '6h' | '24h' | '7d' | '30d'
export const HISTORY_RANGES: HistoryRange[] = ['15m', '1h', '6h', '24h', '7d', '30d']

/** O que se quer ver: o cluster, um nó, um namespace ou um workload. */
export type HistoryScope =
  | { kind: 'cluster' }
  | { kind: 'node'; name: string }
  | { kind: 'namespace'; name: string }
  | { kind: 'workload'; namespace: string; name: string; ownerKind: string }

export const scopeId = (s: HistoryScope) =>
  s.kind === 'cluster' ? 'cluster' : s.kind === 'workload' ? `workload/${s.namespace}/${s.ownerKind}/${s.name}` : `${s.kind}/${s.name}`

export function scopeFromId(id: string): HistoryScope {
  const [kind, a, b, c] = id.split('/')
  if (kind === 'node' || kind === 'namespace') return { kind, name: a }
  if (kind === 'workload') return { kind, namespace: a, ownerKind: b, name: c }
  return { kind: 'cluster' }
}

export interface HistoryStatus {
  state: 'starting' | 'ok' | 'missing' | 'forbidden' | 'error' | 'disabled'
  error?: string
  lastSample?: string
  interval?: string
  retention?: string
  series?: number
  dbBytes?: number
}

/** Colunas de cada ponto, como o servidor envia. */
export interface HistoryData {
  step: number
  points: [number, number, number, number, number, number, number, number, number][]
}

export function useHistoryStatus() {
  return useQuery({ queryKey: ['metrics-history', 'status'], queryFn: () => apiGet<HistoryStatus>('/api/v1/metrics/status'), refetchInterval: 30_000 })
}

export function useHistory(scope: HistoryScope, range: HistoryRange, enabled = true) {
  const q = new URLSearchParams({ range, kind: scope.kind })
  if (scope.kind === 'node' || scope.kind === 'namespace') q.set('name', scope.name)
  if (scope.kind === 'workload') {
    q.set('namespace', scope.namespace)
    q.set('name', scope.name)
    q.set('ownerKind', scope.ownerKind)
  }
  return useQuery({
    queryKey: ['metrics-history', scopeId(scope), range],
    queryFn: () => apiGet<HistoryData>(`/api/v1/metrics/history?${q}`),
    // Períodos curtos mudam a cada amostra; os longos, a cada média de 5 min.
    refetchInterval: range === '15m' || range === '1h' || range === '6h' ? 30_000 : 300_000,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    enabled,
  })
}

export interface Prepared {
  ts: number[]
  col: (i: number) => (number | null)[]
}

/**
 * Prepara as colunas para o gráfico, com lacunas (null) onde faltam amostras:
 * o coletor parado não vira uma linha reta ligando os dois lados.
 */
export function prepare(data: HistoryData): Prepared {
  const ts: number[] = []
  const rows: (number | null)[][] = []
  const gap = data.step * 2.5
  data.points.forEach((p, i) => {
    if (i > 0 && p[0] - data.points[i - 1][0] > gap) {
      ts.push(data.points[i - 1][0] + data.step)
      rows.push(new Array(8).fill(null))
    }
    ts.push(p[0])
    rows.push(p.slice(1))
  })
  return { ts, col: (i) => rows.map((r) => r[i]) }
}

/** Média e máximo de uma série (ignora lacunas). */
export function stats(values: (number | null)[]) {
  const v = values.filter((x): x is number => x != null)
  if (v.length === 0) return null
  return { avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v), last: v[v.length - 1] }
}
