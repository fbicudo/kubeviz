import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ObjectLink } from '@/components/resources/ObjectLink'
import type { Status } from '@/components/ui/stat-tile'
import { StatusBadge } from '@/components/ui/status-badge'
import { age } from '@/lib/format'
import { kinds } from '@/lib/k8s/catalog'
import { HEALTH_KINDS, healthOf, type HealthIssue, type HealthKind } from '@/lib/k8s/health'
import type { Node, Pod } from '@/lib/k8s/types'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

const LIMIT = 10

// Gravidade de cada indicador quando há ocorrências.
const severity: Record<HealthKind, Status> = { restarts: 'warn', oom: 'critical', pending: 'warn', notReady: 'critical' }
const dot: Record<Status, string> = { ok: 'bg-ok', warn: 'bg-warn', critical: 'bg-critical', unknown: 'bg-subtle' }

interface HealthPanelProps {
  pods?: Pod[]
  nodes?: Node[]
  /** Listas que não puderam ser lidas (ex.: sem permissão para nós). */
  error?: string
}

/**
 * Indicadores de saúde: reinícios recentes, OOMKilled, pods pendentes e nós
 * fora do ar. Cada indicador filtra a lista de ocorrências abaixo.
 */
export function HealthPanel({ pods, nodes, error }: HealthPanelProps) {
  const { t } = useTranslation()
  const now = useNow()
  const health = useMemo(() => healthOf(pods ?? [], nodes ?? [], now), [pods, nodes, now])
  const [filter, setFilter] = useState<HealthKind | null>(null)
  const [all, setAll] = useState(false)
  const loaded = pods !== undefined && nodes !== undefined

  const issues = (filter ? [filter] : HEALTH_KINDS).flatMap((k) => health[k].map((issue) => ({ kind: k, issue })))
  const total = HEALTH_KINDS.reduce((n, k) => n + health[k].length, 0)
  const shown = all ? issues : issues.slice(0, LIMIT)

  return (
    <section aria-label={t('health.title')} className="space-y-3 rounded-lg border bg-surface p-3">
      <h2 className="font-semibold">{t('health.title')}</h2>
      {error && <p className="text-xs text-muted">{t('health.partial', { error })}</p>}
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {HEALTH_KINDS.map((k) => {
          const n = health[k].length
          const status: Status = !loaded ? 'unknown' : n > 0 ? severity[k] : 'ok'
          return (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => {
                setFilter(filter === k ? null : k)
                setAll(false)
              }}
              className={cn(
                'rounded-md border p-2 text-left hover:bg-surface-raised',
                filter === k && 'border-accent bg-accent/10',
              )}
            >
              <span className="flex items-center gap-2 text-xs text-muted">
                <span className={cn('size-2 rounded-full', dot[status])} aria-hidden />
                {t(`health.kind.${k}`)}
              </span>
              <span className="mt-1 block font-mono text-xl font-semibold">{loaded ? n : '…'}</span>
              <span className="block text-xs text-subtle">{t(`health.hint.${k}`)}</span>
            </button>
          )
        })}
      </div>

      {loaded && issues.length === 0 && (
        <p className="text-muted">{filter ? t('health.noneOf', { what: t(`health.kind.${filter}`) }) : t('health.none')}</p>
      )}
      {issues.length > 0 && (
        <table className="w-full text-left">
          <caption className="sr-only">{t('health.listCaption')}</caption>
          <thead className="text-xs text-muted">
            <tr>
              <th className="pb-1 font-medium">{t('health.col.what')}</th>
              <th className="pb-1 font-medium">{t('health.col.object')}</th>
              <th className="pb-1 font-medium">{t('health.col.reason')}</th>
              <th className="pb-1 text-right font-medium">{t('health.col.since')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map(({ kind, issue }) => (
              <IssueRow key={`${kind}/${issueKey(issue)}`} kind={kind} issue={issue} now={now} />
            ))}
          </tbody>
        </table>
      )}
      {issues.length > LIMIT && (
        <button type="button" className="text-xs text-accent hover:underline" onClick={() => setAll(!all)}>
          {all ? t('health.showLess') : t('health.showAll', { count: issues.length })}
        </button>
      )}
      {total > 0 && <p className="sr-only">{t('health.total', { count: total })}</p>}
    </section>
  )
}

const issueKey = (i: HealthIssue) => (i.pod ? `${i.pod.metadata.namespace}/${i.pod.metadata.name}` : (i.node?.metadata.name ?? ''))

function IssueRow({ kind, issue, now }: { kind: HealthKind; issue: HealthIssue; now: number }) {
  const { t } = useTranslation()
  const pod = issue.pod
  return (
    <tr className="align-top">
      <td className="py-1.5 pr-3 whitespace-nowrap">
        <StatusBadge severity={severity[kind]}>{t(`health.kind.${kind}`)}</StatusBadge>
      </td>
      <td className="min-w-0 py-1.5 pr-3">
        {pod ? (
          <>
            <ObjectLink kind={kinds.pods} name={pod.metadata.name} namespace={pod.metadata.namespace} className="break-all" />
            <span className="block text-xs text-muted">
              {pod.metadata.namespace}
              {issue.container && ` · ${t('health.container', { name: issue.container })}`}
            </span>
          </>
        ) : (
          issue.node && <ObjectLink kind={kinds.nodes} name={issue.node.metadata.name} className="break-all" />
        )}
      </td>
      <td className="py-1.5 pr-3">
        <span className="font-mono text-xs">{issue.reason}</span>
        {issue.restarts !== undefined && <span className="ml-2 text-xs text-muted">{t('detail.restarts', { count: issue.restarts })}</span>}
        {issue.message && (
          <span className="block max-w-xl truncate text-xs text-muted" title={issue.message}>
            {issue.message}
          </span>
        )}
      </td>
      <td className="py-1.5 text-right font-mono text-xs whitespace-nowrap text-muted" title={issue.since}>
        {issue.since ? age(issue.since, now) : '—'}
      </td>
    </tr>
  )
}
