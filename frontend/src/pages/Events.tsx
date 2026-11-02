import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FilterInput, LoadError, NamespacePicker } from '@/components/resources/common'
import { LiveIndicator } from '@/components/resources/LiveIndicator'
import { ObjectLink } from '@/components/resources/ObjectLink'
import { StatusBadge } from '@/components/ui/status-badge'
import { age } from '@/lib/format'
import { collectionPath, kindOfOwner, kinds } from '@/lib/k8s/catalog'
import { useK8sListLive, useSlimK8sList } from '@/lib/k8s/queries'
import { lastSeen } from '@/lib/k8s/events'
import type { KubeEvent } from '@/lib/k8s/types'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/** Máximo de eventos exibidos (os mais recentes). */
const MAX_EVENTS = 500


/** Eventos do cluster ao vivo, com filtros por tipo, namespace e texto. */
export function Events() {
  const { t } = useTranslation()
  const now = useNow()
  const navigate = useNavigate()
  const namespace = (useSearch({ strict: false }) as { ns?: string }).ns ?? ''
  const [onlyWarnings, setOnlyWarnings] = useState(false)
  const [filter, setFilter] = useState('')
  const path = collectionPath(kinds.events, namespace)
  const key = ['k8s', 'events', namespace] as const
  const list = useSlimK8sList<KubeEvent>(key, path)
  const live = useK8sListLive<KubeEvent>(key, path, list.isSuccess, true)

  const all = useMemo(() => list.data?.items ?? [], [list.data])
  const warnings = all.filter((e) => e.type === 'Warning').length
  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return all
      .filter((e) => !onlyWarnings || e.type === 'Warning')
      .filter(
        (e) =>
          !term ||
          [e.reason, e.message, e.involvedObject?.name, e.involvedObject?.kind, e.metadata.namespace]
            .filter(Boolean)
            .some((s) => s!.toLowerCase().includes(term)),
      )
      .sort((a, b) => lastSeen(b).localeCompare(lastSeen(a)))
      .slice(0, MAX_EVENTS)
  }, [all, onlyWarnings, filter])

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">{t('nav.events')}</h1>
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label={t('events.type')} className="flex rounded-md border p-0.5">
          {[false, true].map((w) => (
            <button
              key={String(w)}
              type="button"
              role="radio"
              aria-checked={onlyWarnings === w}
              onClick={() => setOnlyWarnings(w)}
              className={cn('rounded px-2.5 py-1 text-xs', onlyWarnings === w ? 'bg-accent/15 text-foreground' : 'text-muted hover:text-foreground')}
            >
              {w ? t('events.warnings', { count: warnings }) : t('events.all', { count: all.length })}
            </button>
          ))}
        </div>
        <span className="mr-auto" />
        {!list.isError && <LiveIndicator state={live} />}
        <NamespacePicker value={namespace} onChange={(ns) => void navigate({ to: '/events', search: ns ? { ns } : {} } as never)} />
        <FilterInput value={filter} onChange={setFilter} />
      </div>

      {list.isError ? (
        <LoadError error={list.error} what={t('kinds.events')} namespace={namespace} namespaced />
      ) : (
        <ul className="divide-y rounded-lg border bg-surface" aria-label={t('nav.events')}>
          {rows.map((e) => {
            const io = e.involvedObject
            const ok = io?.kind && io.apiVersion ? kindOfOwner(io.apiVersion, io.kind) : undefined
            return (
              <li key={e.metadata.uid} className="flex gap-3 px-4 py-2">
                <span className="w-36 shrink-0">
                  <StatusBadge severity={e.type === 'Warning' ? 'warn' : 'unknown'}>{e.reason ?? e.type ?? '—'}</StatusBadge>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted">
                    {io?.kind}{' '}
                    {ok && io?.name ? (
                      <ObjectLink kind={ok} name={io.name} namespace={ok.namespaced ? io.namespace : undefined} />
                    ) : (
                      <span className="text-foreground">{io?.name}</span>
                    )}
                    {!namespace && e.metadata.namespace && ` · ${e.metadata.namespace}`}
                  </div>
                  <div className="break-words">{e.message}</div>
                  <div className="text-xs text-subtle">
                    {e.reportingComponent || e.source?.component}
                    {(e.count ?? e.series?.count ?? 1) > 1 && ` · ${t('detail.times', { count: e.count ?? e.series?.count })}`}
                  </div>
                </div>
                <span className="font-mono text-xs whitespace-nowrap text-muted" title={lastSeen(e)}>
                  {age(lastSeen(e), now)}
                </span>
              </li>
            )
          })}
          {list.isSuccess && rows.length === 0 && <li className="p-6 text-center text-muted">{t('events.empty')}</li>}
          {list.isPending && <li className="p-6 text-center text-muted">{t('resources.loading')}</li>}
        </ul>
      )}
      {rows.length === MAX_EVENTS && <p className="text-xs text-muted">{t('events.capped', { max: MAX_EVENTS })}</p>}
    </div>
  )
}
