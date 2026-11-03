// Indicadores de saúde do cluster: o que costuma ser a causa de um problema
// (reinícios, falta de memória, pods que não sobem, nós fora do ar).
// Calculados a partir das listas de pods e nós, com a credencial de quem vê.

import { isNodeReady } from './pods'
import type { Node, Pod } from './types'

export type HealthKind = 'restarts' | 'oom' | 'pending' | 'notReady'
export const HEALTH_KINDS: HealthKind[] = ['restarts', 'oom', 'pending', 'notReady']

/** Janelas: reinícios na última hora, OOM no último dia, pendente há 2 min. */
export const RESTART_WINDOW_MS = 60 * 60 * 1000
export const OOM_WINDOW_MS = 24 * 60 * 60 * 1000
export const PENDING_AFTER_MS = 2 * 60 * 1000

export interface HealthIssue {
  /** Pod ou nó afetado. */
  pod?: Pod
  node?: Node
  /** Motivo curto (CrashLoopBackOff, Unschedulable, KubeletNotReady…). */
  reason?: string
  /** Mensagem do Kubernetes, quando há. */
  message?: string
  /** Desde quando (ISO), para ordenar e mostrar "há X". */
  since?: string
  /** Reinícios somados dos containers (só para "restarts"). */
  restarts?: number
  /** Container afetado (OOM, reinícios). */
  container?: string
}

export type Health = Record<HealthKind, HealthIssue[]>

const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN)

/** Pods que reiniciaram na última hora ou estão em CrashLoopBackOff. */
function restartIssue(pod: Pod, now: number): HealthIssue | undefined {
  let latest: HealthIssue | undefined
  for (const c of pod.status.containerStatuses ?? []) {
    const last = c.lastState?.terminated
    const crash = c.state?.waiting?.reason === 'CrashLoopBackOff'
    const recent = last?.finishedAt && now - ms(last.finishedAt) <= RESTART_WINDOW_MS
    if (c.restartCount === 0 || (!crash && !recent)) continue
    if (!latest || (last?.finishedAt ?? '') > (latest.since ?? '')) {
      latest = {
        pod,
        container: c.name,
        reason: crash ? 'CrashLoopBackOff' : last?.reason,
        message: c.state?.waiting?.message,
        since: last?.finishedAt,
      }
    }
  }
  if (latest) latest.restarts = (pod.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0)
  return latest
}

/** Containers mortos por falta de memória (limit atingido) no último dia. */
function oomIssue(pod: Pod, now: number): HealthIssue | undefined {
  for (const c of pod.status.containerStatuses ?? []) {
    for (const t of [c.state?.terminated, c.lastState?.terminated]) {
      if (t?.reason === 'OOMKilled' && (!t.finishedAt || now - ms(t.finishedAt) <= OOM_WINDOW_MS)) {
        return { pod, container: c.name, reason: 'OOMKilled', since: t.finishedAt }
      }
    }
  }
  return undefined
}

/** Pods pendentes há mais de 2 min: sem nó (Unschedulable) ou sem conseguir iniciar. */
function pendingIssue(pod: Pod, now: number): HealthIssue | undefined {
  if (pod.status.phase !== 'Pending' || pod.metadata.deletionTimestamp) return undefined
  const created = pod.metadata.creationTimestamp
  if (now - ms(created) < PENDING_AFTER_MS) return undefined
  const scheduled = pod.status.conditions?.find((c) => c.type === 'PodScheduled')
  if (scheduled?.status === 'False') {
    return { pod, reason: scheduled.reason ?? 'Unschedulable', message: scheduled.message, since: created }
  }
  const waiting = [...(pod.status.initContainerStatuses ?? []), ...(pod.status.containerStatuses ?? [])].find((c) => c.state?.waiting)
  return { pod, reason: waiting?.state?.waiting?.reason ?? 'Pending', message: waiting?.state?.waiting?.message, container: waiting?.name, since: created }
}

function notReadyIssue(node: Node): HealthIssue | undefined {
  if (isNodeReady(node)) return undefined
  const ready = node.status.conditions?.find((c) => c.type === 'Ready')
  return {
    node,
    reason: ready ? (ready.reason ?? `Ready=${ready.status}`) : 'Unknown',
    message: ready?.message,
    since: ready?.lastTransitionTime,
  }
}

/** Indicadores, cada lista do mais recente para o mais antigo. */
export function healthOf(pods: Pod[], nodes: Node[], now = Date.now()): Health {
  const out: Health = { restarts: [], oom: [], pending: [], notReady: [] }
  for (const pod of pods) {
    const r = restartIssue(pod, now)
    if (r) out.restarts.push(r)
    const o = oomIssue(pod, now)
    if (o) out.oom.push(o)
    const p = pendingIssue(pod, now)
    if (p) out.pending.push(p)
  }
  for (const node of nodes) {
    const n = notReadyIssue(node)
    if (n) out.notReady.push(n)
  }
  for (const k of HEALTH_KINDS) out[k].sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''))
  return out
}
