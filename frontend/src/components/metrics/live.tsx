// Tabelas e avisos das métricas ao vivo, usados na página Métricas e na aba
// Métricas do detalhe.

import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ObjectLink } from '@/components/resources/ObjectLink'
import { UsageBar } from '@/components/ui/usage-bar'
import { kinds } from '@/lib/k8s/catalog'
import { formatBytes, formatCpu, type PodRow } from '@/lib/k8s/metrics'
import { cn } from '@/lib/utils'

/** Pods com uso ao vivo; a barra é relativa ao limit (ou ao maior da lista). */
export function PodTable({ rows, sort, hideNamespace }: { rows: PodRow[]; sort?: 'cpu' | 'memory'; hideNamespace?: boolean }) {
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
                {!hideNamespace && <span className="ml-2 text-xs text-muted">{r.pod.metadata.namespace}</span>}
              </td>
              <td className="px-3 py-2">{r.measured ? <UsageBar label={t('metrics.cpuOf', { name: r.pod.metadata.name })} used={r.cpu} max={r.cpuLimits || maxCpu} reserved={r.cpuRequests} text={formatCpu(r.cpu)} percent={!!r.cpuLimits} /> : <span className="text-xs text-muted">{t('metrics.notMeasured')}</span>}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted">{r.cpuRequests ? formatCpu(r.cpuRequests) : '—'} / {r.cpuLimits ? formatCpu(r.cpuLimits) : '—'}</td>
              <td className="px-3 py-2">{r.measured ? <UsageBar label={t('metrics.memoryOf', { name: r.pod.metadata.name })} used={r.memory} max={r.memoryLimits || maxMem} reserved={r.memoryRequests} text={formatBytes(r.memory)} percent={!!r.memoryLimits} /> : <span className="text-xs text-muted">{t('metrics.notMeasured')}</span>}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted">{r.memoryRequests ? formatBytes(r.memoryRequests) : '—'} / {r.memoryLimits ? formatBytes(r.memoryLimits) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Sem metrics-server, sem permissão ou erro: explica o que fazer. */
export function MetricsProblem({ problem }: { problem: 'missing' | 'forbidden' | 'error' }) {
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
