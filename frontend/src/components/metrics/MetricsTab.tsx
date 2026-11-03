import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { HistoryPanel } from '@/components/charts/HistoryPanel'
import { UsageBar } from '@/components/ui/usage-bar'
import { kindOfOwner } from '@/lib/k8s/catalog'
import type { HistoryScope } from '@/lib/k8s/history'
import {
  cpuMillis,
  formatBytes,
  formatCpu,
  metricsProblem,
  parseQuantity,
  podRows,
  useNodeMetrics,
  usePodMetrics,
  workloadOf,
  WORKLOAD_KINDS,
  type PodRow,
} from '@/lib/k8s/metrics'
import { usePods } from '@/lib/k8s/queries'
import type { K8sObject, Node, Pod } from '@/lib/k8s/types'
import { MetricsProblem, PodTable } from './live'

/** Aba Métricas do detalhe: uso ao vivo e histórico do objeto. */
export function MetricsTab({ obj }: { obj: K8sObject }) {
  if (obj.kind === 'Node') return <NodeMetrics node={obj as unknown as Node} />
  if (obj.kind === 'Pod') return <PodMetrics pod={obj as unknown as Pod} />
  return <WorkloadMetrics obj={obj} />
}

function Live({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="overflow-x-auto rounded-lg border bg-surface">
      <h2 className="border-b px-3 py-2 font-semibold">{title}</h2>
      {children}
    </section>
  )
}

const byCpu = (rows: PodRow[]) => [...rows].sort((a, b) => b.cpu - a.cpu)

function NodeMetrics({ node }: { node: Node }) {
  const { t } = useTranslation()
  const name = node.metadata.name
  const metrics = useNodeMetrics()
  const pods = usePods('')
  const podMetrics = usePodMetrics('')
  const rows = useMemo(
    () => byCpu(podRows((pods.data?.items ?? []).filter((p) => p.spec.nodeName === name), podMetrics.data?.items ?? [])),
    [pods.data, podMetrics.data, name],
  )
  const usage = metrics.data?.items.find((m) => m.metadata.name === name)?.usage
  const cpuAlloc = cpuMillis(node.status.allocatable?.cpu)
  const memAlloc = parseQuantity(node.status.allocatable?.memory)
  const req = rows.reduce((a, r) => ({ cpu: a.cpu + r.cpuRequests, mem: a.mem + r.memoryRequests }), { cpu: 0, mem: 0 })
  const cpu = cpuMillis(usage?.cpu)
  const mem = parseQuantity(usage?.memory)

  return (
    <div className="space-y-4">
      {metrics.isError ? (
        <MetricsProblem problem={metricsProblem(metrics.error)} />
      ) : (
        <Live title={t('metrics.now')}>
          <dl className="grid gap-3 p-3 sm:grid-cols-2">
            <div>
              <dt className="mb-1 text-xs text-muted">CPU</dt>
              <dd>
                <UsageBar label={t('metrics.cpuOf', { name })} used={cpu} max={cpuAlloc} reserved={req.cpu} text={usage ? `${formatCpu(cpu)} / ${formatCpu(cpuAlloc)}` : t('metrics.notMeasured')} percent={!!usage} />
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-xs text-muted">{t('metrics.col.memory')}</dt>
              <dd>
                <UsageBar label={t('metrics.memoryOf', { name })} used={mem} max={memAlloc} reserved={req.mem} text={usage ? `${formatBytes(mem)} / ${formatBytes(memAlloc)}` : t('metrics.notMeasured')} percent={!!usage} />
              </dd>
            </div>
          </dl>
          <p className="px-3 pb-2 text-xs text-subtle">{t('metrics.barHint')}</p>
        </Live>
      )}
      <HistoryPanel scope={{ kind: 'node', name }} />
      {!podMetrics.isError && rows.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">{t('metrics.podsOnNode', { count: rows.length })}</h2>
          <PodTable rows={rows} sort="cpu" />
        </div>
      )}
    </div>
  )
}

function PodMetrics({ pod }: { pod: Pod }) {
  const { t } = useTranslation()
  const ns = pod.metadata.namespace ?? ''
  const metrics = usePodMetrics(ns)
  const m = metrics.data?.items.find((x) => x.metadata.name === pod.metadata.name)
  // Pods terminados não reservam recursos.
  const active = pod.status.phase !== 'Succeeded' && pod.status.phase !== 'Failed'
  const w = workloadOf(pod)
  const owner = w.kind !== 'Pod' && WORKLOAD_KINDS.has(w.kind) ? kindOfOwner(w.kind === 'Job' ? 'batch/v1' : 'apps/v1', w.kind) : undefined

  return (
    <div className="space-y-4">
      {metrics.isError ? (
        <MetricsProblem problem={metricsProblem(metrics.error)} />
      ) : (
        <Live title={t('metrics.containersNow')}>
          <table className="w-full text-left">
            <thead className="border-b text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.container')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.cpu')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.cpuReqLim')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.memory')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.memReqLim')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {pod.spec.containers.map((c) => {
                const u = m?.containers.find((x) => x.name === c.name)?.usage
                const cpu = cpuMillis(u?.cpu)
                const mem = parseQuantity(u?.memory)
                const cpuReq = active ? cpuMillis(c.resources?.requests?.cpu) : 0
                const cpuLim = cpuMillis(c.resources?.limits?.cpu)
                const memReq = active ? parseQuantity(c.resources?.requests?.memory) : 0
                const memLim = parseQuantity(c.resources?.limits?.memory)
                return (
                  <tr key={c.name}>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{c.name}</td>
                    <td className="px-3 py-2">
                      {u ? (
                        <UsageBar label={t('metrics.cpuOf', { name: c.name })} used={cpu} max={cpuLim || Math.max(cpu, cpuReq, 1)} reserved={cpuReq} text={formatCpu(cpu)} percent={!!cpuLim} />
                      ) : (
                        <span className="text-xs text-muted">{t('metrics.notMeasured')}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">{cpuReq ? formatCpu(cpuReq) : '—'} / {cpuLim ? formatCpu(cpuLim) : '—'}</td>
                    <td className="px-3 py-2">
                      {u ? (
                        <UsageBar label={t('metrics.memoryOf', { name: c.name })} used={mem} max={memLim || Math.max(mem, memReq, 1)} reserved={memReq} text={formatBytes(mem)} percent={!!memLim} />
                      ) : (
                        <span className="text-xs text-muted">{t('metrics.notMeasured')}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">{memReq ? formatBytes(memReq) : '—'} / {memLim ? formatBytes(memLim) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="px-3 pb-2 text-xs text-subtle">{t('metrics.containerBarHint')}</p>
        </Live>
      )}
      <HistoryPanel scope={{ kind: 'pod', namespace: ns, name: pod.metadata.name }} />
      {owner && (
        <p className="text-xs text-muted">
          <Link
            to="/view/$group/$version/$resource/$name"
            params={{ group: owner.group || 'core', version: owner.version, resource: owner.resource, name: w.name }}
            search={{ ns, tab: 'metrics' } as never}
            className="text-accent hover:underline"
          >
            {t('metrics.workloadHistory', { kind: w.kind, name: w.name })}
          </Link>
        </p>
      )}
    </div>
  )
}

function WorkloadMetrics({ obj }: { obj: K8sObject }) {
  const { t } = useTranslation()
  const ns = obj.metadata.namespace ?? ''
  const name = obj.metadata.name
  const pods = usePods(ns)
  const metrics = usePodMetrics(ns)
  const rows = useMemo(() => {
    const mine = (pods.data?.items ?? []).filter((p) => {
      const w = workloadOf(p)
      return w.kind === obj.kind && w.name === name
    })
    return byCpu(podRows(mine, metrics.data?.items ?? []))
  }, [pods.data, metrics.data, obj.kind, name])
  const scope: HistoryScope = { kind: 'workload', namespace: ns, ownerKind: obj.kind ?? '', name }
  const total = rows.reduce((a, r) => ({ cpu: a.cpu + r.cpu, mem: a.mem + r.memory }), { cpu: 0, mem: 0 })

  return (
    <div className="space-y-4">
      <HistoryPanel scope={scope} />
      {metrics.isError ? (
        <MetricsProblem problem={metricsProblem(metrics.error)} />
      ) : (
        <div className="space-y-2">
          <h2 className="font-semibold">
            {t('metrics.workloadPods', { count: rows.length })}
            {rows.some((r) => r.measured) && (
              <span className="ml-2 font-mono text-xs font-normal text-muted">
                {t('metrics.total', { cpu: formatCpu(total.cpu), memory: formatBytes(total.mem) })}
              </span>
            )}
          </h2>
          {rows.length > 0 ? <PodTable rows={rows} sort="cpu" hideNamespace /> : <p className="text-muted">{t('metrics.noPods')}</p>}
        </div>
      )}
    </div>
  )
}
