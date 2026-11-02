import type { Status as Severity } from '@/components/ui/stat-tile'
import type { Node, Pod } from './types'

export interface PodSummary {
  /** Texto de status no estilo do `kubectl get pods`. */
  status: string
  severity: Severity
  ready: number
  total: number
  restarts: number
}

const critical = new Set([
  'CrashLoopBackOff',
  'Error',
  'Failed',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'OOMKilled',
  'Evicted',
  'RunContainerError',
])

/**
 * Calcula o status exibido de um pod seguindo a mesma lógica do kubectl:
 * motivos de espera/término dos containers têm precedência sobre a fase.
 */
export function summarizePod(pod: Pod): PodSummary {
  const statuses = pod.status.containerStatuses ?? []
  const total = pod.spec.containers.length
  const ready = statuses.filter((c) => c.ready).length
  const restarts = statuses.reduce((n, c) => n + c.restartCount, 0)

  let status: string = pod.status.reason ?? pod.status.phase ?? 'Unknown'

  // Containers de inicialização ainda não concluídos.
  const inits = pod.status.initContainerStatuses ?? []
  const initCount = pod.spec.initContainers?.length ?? 0
  let initializing = false
  inits.forEach((c, i) => {
    const t = c.state?.terminated
    if (t && t.exitCode === 0) return
    initializing = true
    if (t) status = t.reason ? `Init:${t.reason}` : `Init:ExitCode:${t.exitCode}`
    else if (c.state?.waiting?.reason && c.state.waiting.reason !== 'PodInitializing')
      status = `Init:${c.state.waiting.reason}`
    else status = `Init:${i}/${initCount}`
  })

  if (!initializing) {
    let hasRunning = false
    for (const c of [...statuses].reverse()) {
      if (c.state?.waiting?.reason) status = c.state.waiting.reason
      else if (c.state?.terminated?.reason) status = c.state.terminated.reason
      else if (c.state?.terminated)
        status = c.state.terminated.signal
          ? `Signal:${c.state.terminated.signal}`
          : `ExitCode:${c.state.terminated.exitCode}`
      else if (c.ready && c.state?.running) hasRunning = true
    }
    // Pod "Completed" com algum container ainda rodando.
    if (status === 'Completed' && hasRunning) status = ready === total ? 'Running' : 'NotReady'
  }

  if (pod.metadata.deletionTimestamp) status = 'Terminating'

  return { status, severity: severityOf(status, ready, total), ready, total, restarts }
}

function severityOf(status: string, ready: number, total: number): Severity {
  const base = status.startsWith('Init:') ? status.slice('Init:'.length) : status
  if (critical.has(base) || base.startsWith('Signal:') || (base.startsWith('ExitCode:') && base !== 'ExitCode:0')) {
    return 'critical'
  }
  if (status === 'Running') return ready === total ? 'ok' : 'warn'
  if (status === 'Completed' || status === 'Succeeded') return 'unknown'
  return 'warn'
}

export function isNodeReady(node: Node): boolean {
  return node.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false
}
