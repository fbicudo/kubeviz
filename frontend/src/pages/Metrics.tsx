import { ChartLine, RefreshCw, TriangleAlert } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HistoryPanel } from '@/components/charts/HistoryPanel'
import { ObjectLink } from '@/components/resources/ObjectLink'
import { Button } from '@/components/ui/button'
import { StatTile } from '@/components/ui/stat-tile'
import { UsageBar } from '@/components/ui/usage-bar'
import { kindOfOwner, kinds } from '@/lib/k8s/catalog'
import {
  formatBytes,
  formatCpu,
  groupBy,
  metricsProblem,
  nodeRows,
  podRows,
  useNodeMetrics,
  usePodMetrics,
  type GroupRow,
  type PodRow,
} from '@/lib/k8s/metrics'
import { useNodes, usePods } from '@/lib/k8s/queries'
import { scopeId, type HistoryScope } from '@/lib/k8s/history'
import type { ComboboxOption } from '@/components/ui/combobox'
import { cn } from '@/lib/utils'

type SortKey = 'cpu' | 'memory'
const TOP = 10

/** Métricas ao vivo: o que está consumindo CPU e memória agora. */
export function Metrics() {
  const { t } = useTranslation()
  const nodes = useNodes()
  const pods = usePods('')
  const nodeMetrics = useNodeMetrics()
  const podMetrics = usePodMetrics('')
  const [sort, setSort] = useState<SortKey>('cpu')
  const [scope, setScope] = useState<'workloads' | 'pods'>('workloads')
  const [historyScope, setHistoryScope] = useState<HistoryScope>({ kind: 'cluster' })
  const historyRef = useRef<HTMLDivElement>(null)
  const showHistory = (s: HistoryScope) => {
    setHistoryScope(s)
    historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const rows = useMemo(() => podRows(pods.data?.items ?? [], podMetrics.data?.items ?? []), [pods.data, podMetrics.data])
  const nodeList = useMemo(() => nodeRows(nodes.data?.items ?? [], nodeMetrics.data?.items ?? [], rows), [nodes.data, nodeMetrics.data, rows])
  const namespaces = useMemo(() => groupBy(rows, (r) => r.pod.metadata.namespace ?? '').sort((a, b) => b[sort] - a[sort]), [rows, sort])
  const workloads = useMemo(
    () => groupBy(rows, (r) => `${r.workload.namespace}/${r.workload.kind}/${r.workload.name}`).sort((a, b) => b[sort] - a[sort]).slice(0, TOP),
    [rows, sort],
  )
  // Escopos do histórico: o cluster, cada nó, cada namespace e cada workload.
  const scopeOptions = useMemo<ComboboxOption[]>(() => {
    const opts: ComboboxOption[] = [{ value: 'cluster', label: t('history.cluster') }]
    for (const n of nodeList) opts.push({ value: scopeId({ kind: 'node', name: n.node.metadata.name }), label: n.node.metadata.name, hint: t('history.node') })
    for (const g of groupBy(rows, (r) => r.pod.metadata.namespace ?? '')) opts.push({ value: scopeId({ kind: 'namespace', name: g.key }), label: g.key, hint: t('history.namespace') })
    for (const g of groupBy(rows, (r) => `${r.workload.namespace}/${r.workload.kind}/${r.workload.name}`)) {
      const [namespace, ownerKind, name] = g.key.split('/')
      opts.push({ value: scopeId({ kind: 'workload', namespace, ownerKind, name }), label: name, hint: `${ownerKind} · ${namespace}` })
    }
    return opts
  }, [nodeList, rows, t])
  const topPods = useMemo(() => [...rows].filter((r) => r.measured).sort((a, b) => b[sort] - a[sort]).slice(0, TOP), [rows, sort])

  const problem = nodeMetrics.isError ? metricsProblem(nodeMetrics.error) : podMetrics.isError ? metricsProblem(podMetrics.error) : null
  const total = nodeList.reduce(
    (acc, n) => ({
      cpu: acc.cpu + n.cpu,
      memory: acc.memory + n.memory,
      cpuAlloc: acc.cpuAlloc + n.cpuAllocatable,
      memAlloc: acc.memAlloc + n.memoryAllocatable,
      cpuReq: acc.cpuReq + n.cpuRequests,
      memReq: acc.memReq + n.memoryRequests,
    }),
    { cpu: 0, memory: 0, cpuAlloc: 0, memAlloc: 0, cpuReq: 0, memReq: 0 },
  )
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)
  const updated = nodeMetrics.dataUpdatedAt ? new Date(nodeMetrics.dataUpdatedAt).toLocaleTimeString() : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">{t('nav.metrics')}</h1>
          <p className="text-muted">{t('metrics.subtitle')}</p>
        </div>
        {updated && !problem && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <RefreshCw className={cn('size-3.5', nodeMetrics.isFetching && 'animate-spin')} aria-hidden />
            {t('metrics.updated', { time: updated })}
          </span>
        )}
      </div>

      {problem && <MetricsProblem problem={problem} />}

      {!problem && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label={t('metrics.cpuUsed')} value={`${pct(total.cpu, total.cpuAlloc)}%`} hint={t('metrics.ofAllocatable', { used: formatCpu(total.cpu), total: formatCpu(total.cpuAlloc) })} status={level(total.cpu, total.cpuAlloc)} />
            <StatTile label={t('metrics.cpuRequested')} value={`${pct(total.cpuReq, total.cpuAlloc)}%`} hint={t('metrics.ofAllocatable', { used: formatCpu(total.cpuReq), total: formatCpu(total.cpuAlloc) })} status={level(total.cpuReq, total.cpuAlloc)} />
            <StatTile label={t('metrics.memoryUsed')} value={`${pct(total.memory, total.memAlloc)}%`} hint={t('metrics.ofAllocatable', { used: formatBytes(total.memory), total: formatBytes(total.memAlloc) })} status={level(total.memory, total.memAlloc)} />
            <StatTile label={t('metrics.memoryRequested')} value={`${pct(total.memReq, total.memAlloc)}%`} hint={t('metrics.ofAllocatable', { used: formatBytes(total.memReq), total: formatBytes(total.memAlloc) })} status={level(total.memReq, total.memAlloc)} />
          </div>

          <div ref={historyRef} className="scroll-mt-4">
            <HistoryPanel scope={historyScope} onScope={setHistoryScope} options={scopeOptions} />
          </div>

          <Section title={t('metrics.nodes')}>
            <table className="w-full text-left">
              <thead className="border-b text-xs text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.node')}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.cpu')}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.memory')}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.pods')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {nodeList.map((n) => (
                  <tr key={n.node.metadata.name}>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">
                      <ObjectLink kind={kinds.nodes} name={n.node.metadata.name} />
                      <HistoryButton name={n.node.metadata.name} onClick={() => showHistory({ kind: 'node', name: n.node.metadata.name })} />
                    </td>
                    <td className="px-3 py-2">
                      <UsageBar label={t('metrics.cpuOf', { name: n.node.metadata.name })} used={n.cpu} max={n.cpuAllocatable} reserved={n.cpuRequests} text={`${formatCpu(n.cpu)} / ${formatCpu(n.cpuAllocatable)}`} />
                    </td>
                    <td className="px-3 py-2">
                      <UsageBar label={t('metrics.memoryOf', { name: n.node.metadata.name })} used={n.memory} max={n.memoryAllocatable} reserved={n.memoryRequests} text={`${formatBytes(n.memory)} / ${formatBytes(n.memoryAllocatable)}`} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{n.pods}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-3 pb-2 text-xs text-subtle">{t('metrics.barHint')}</p>
          </Section>

          <div className="flex flex-wrap items-center gap-3">
            <h2 className="mr-auto font-semibold">{t('metrics.top')}</h2>
            <Toggle label={t('metrics.scope')} value={scope} onChange={setScope} options={[['workloads', t('metrics.workloads')], ['pods', t('metrics.pods')]]} />
            <Toggle label={t('metrics.sortBy')} value={sort} onChange={setSort} options={[['cpu', 'CPU'], ['memory', t('metrics.col.memory')]]} />
          </div>
          {scope === 'workloads' ? <GroupTable rows={workloads} sort={sort} kind="workload" onHistory={showHistory} /> : <PodTable rows={topPods} sort={sort} />}

          <Section title={t('metrics.namespaces')}>
            <GroupTable rows={namespaces} sort={sort} kind="namespace" bare onHistory={showHistory} />
          </Section>
        </>
      )}
    </div>
  )
}

const level = (used: number, total: number) => (total === 0 ? 'unknown' : used / total >= 0.9 ? 'critical' : used / total >= 0.75 ? 'warn' : 'ok')

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-x-auto rounded-lg border bg-surface" aria-label={title}>
      <h2 className="border-b px-3 py-2 font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Toggle<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn('rounded px-2.5 py-1 text-xs', value === v ? 'bg-accent/15 text-foreground' : 'text-muted hover:text-foreground')}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** Barras relativas ao maior valor da lista (não há "capacidade" de namespace ou workload). */
function HistoryButton({ name, onClick }: { name: string; onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <Button size="icon" variant="ghost" className="ml-1 size-6 align-middle" onClick={onClick} aria-label={t('history.show', { name })} title={t('history.show', { name })}>
      <ChartLine />
    </Button>
  )
}

function GroupTable({ rows, sort, kind, bare, onHistory }: { rows: GroupRow[]; sort: SortKey; kind: 'workload' | 'namespace'; bare?: boolean; onHistory: (s: HistoryScope) => void }) {
  const { t } = useTranslation()
  const maxCpu = Math.max(1, ...rows.map((r) => r.cpu))
  const maxMem = Math.max(1, ...rows.map((r) => r.memory))
  const table = (
    <table className="w-full text-left">
      <thead className="border-b text-xs text-muted">
        <tr>
          <th scope="col" className="px-3 py-2 font-medium">{kind === 'workload' ? t('metrics.col.workload') : t('metrics.col.namespace')}</th>
          <th scope="col" className={cn('px-3 py-2 font-medium', sort === 'cpu' && 'text-foreground')}>{t('metrics.col.cpu')}</th>
          <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.cpuReqLim')}</th>
          <th scope="col" className={cn('px-3 py-2 font-medium', sort === 'memory' && 'text-foreground')}>{t('metrics.col.memory')}</th>
          <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.memReqLim')}</th>
          <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.pods')}</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((r) => {
          const [ns, wkind, name] = r.key.split('/')
          const ok = kind === 'workload' ? kindOfOwner(wkind === 'Deployment' || wkind === 'StatefulSet' || wkind === 'DaemonSet' || wkind === 'ReplicaSet' ? 'apps/v1' : wkind === 'Job' ? 'batch/v1' : 'v1', wkind) : undefined
          return (
            <tr key={r.key}>
              <td className="px-3 py-2 whitespace-nowrap">
                {kind === 'workload' ? (
                  <>
                    {ok ? <ObjectLink kind={ok} name={name} namespace={ns} /> : <span>{name}</span>}
                    <HistoryButton name={name} onClick={() => onHistory({ kind: 'workload', namespace: ns, ownerKind: wkind, name })} />
                    <span className="ml-2 text-xs text-muted">
                      {wkind} · {ns}
                    </span>
                  </>
                ) : (
                  <>
                    <ObjectLink kind={kinds.namespaces} name={r.key} />
                    <HistoryButton name={r.key} onClick={() => onHistory({ kind: 'namespace', name: r.key })} />
                  </>
                )}
              </td>
              <td className="px-3 py-2"><UsageBar label={t('metrics.cpuOf', { name: name ?? r.key })} used={r.cpu} max={maxCpu} text={formatCpu(r.cpu)} percent={false} /></td>
              <td className="px-3 py-2 font-mono text-xs text-muted">{r.cpuRequests ? formatCpu(r.cpuRequests) : '—'} / {r.cpuLimits ? formatCpu(r.cpuLimits) : '—'}</td>
              <td className="px-3 py-2"><UsageBar label={t('metrics.memoryOf', { name: name ?? r.key })} used={r.memory} max={maxMem} text={formatBytes(r.memory)} percent={false} /></td>
              <td className="px-3 py-2 font-mono text-xs text-muted">{r.memoryRequests ? formatBytes(r.memoryRequests) : '—'} / {r.memoryLimits ? formatBytes(r.memoryLimits) : '—'}</td>
              <td className="px-3 py-2 font-mono text-xs">{r.pods}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
  return bare ? table : <div className="overflow-x-auto rounded-lg border bg-surface">{table}</div>
}

function PodTable({ rows, sort }: { rows: PodRow[]; sort: SortKey }) {
  const { t } = useTranslation()
  const maxCpu = Math.max(1, ...rows.map((r) => r.cpu))
  const maxMem = Math.max(1, ...rows.map((r) => r.memory))
  return (
    <div className="overflow-x-auto rounded-lg border bg-surface">
      <table className="w-full text-left">
        <thead className="border-b text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.pod')}</th>
            <th scope="col" className={cn('px-3 py-2 font-medium', sort === 'cpu' && 'text-foreground')}>{t('metrics.col.cpu')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.cpuReqLim')}</th>
            <th scope="col" className={cn('px-3 py-2 font-medium', sort === 'memory' && 'text-foreground')}>{t('metrics.col.memory')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('metrics.col.memReqLim')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.pod.metadata.uid}>
              <td className="px-3 py-2 whitespace-nowrap">
                <ObjectLink kind={kinds.pods} name={r.pod.metadata.name} namespace={r.pod.metadata.namespace} />
                <span className="ml-2 text-xs text-muted">{r.pod.metadata.namespace}</span>
              </td>
              <td className="px-3 py-2"><UsageBar label={t('metrics.cpuOf', { name: r.pod.metadata.name })} used={r.cpu} max={r.cpuLimits || maxCpu} reserved={r.cpuRequests} text={formatCpu(r.cpu)} percent={!!r.cpuLimits} /></td>
              <td className="px-3 py-2 font-mono text-xs text-muted">{r.cpuRequests ? formatCpu(r.cpuRequests) : '—'} / {r.cpuLimits ? formatCpu(r.cpuLimits) : '—'}</td>
              <td className="px-3 py-2"><UsageBar label={t('metrics.memoryOf', { name: r.pod.metadata.name })} used={r.memory} max={r.memoryLimits || maxMem} reserved={r.memoryRequests} text={formatBytes(r.memory)} percent={!!r.memoryLimits} /></td>
              <td className="px-3 py-2 font-mono text-xs text-muted">{r.memoryRequests ? formatBytes(r.memoryRequests) : '—'} / {r.memoryLimits ? formatBytes(r.memoryLimits) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MetricsProblem({ problem }: { problem: 'missing' | 'forbidden' | 'error' }) {
  const { t } = useTranslation()
  return (
    <div className="flex gap-3 rounded-lg border border-warn/40 bg-warn/5 p-4">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
      <div className="space-y-2">
        <p className="font-medium">{t(`metrics.problem.${problem}.title`)}</p>
        <p className="text-muted">{t(`metrics.problem.${problem}.body`)}</p>
        {problem === 'missing' && (
          <pre className="overflow-x-auto rounded-md bg-surface-raised p-2 font-mono text-xs">
            kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
          </pre>
        )}
      </div>
    </div>
  )
}
