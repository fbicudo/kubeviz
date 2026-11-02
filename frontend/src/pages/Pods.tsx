import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FilterInput, LoadError, NamespacePicker, RefreshButton } from '@/components/resources/common'
import { ObjectLink } from '@/components/resources/ObjectLink'
import { StatusBadge } from '@/components/ui/status-badge'
import { kinds } from '@/lib/k8s/catalog'
import { age } from '@/lib/format'
import { summarizePod } from '@/lib/k8s/pods'
import { usePods, usePodsLive } from '@/lib/k8s/queries'
import { LiveIndicator } from '@/components/resources/LiveIndicator'
import { VirtualTable } from '@/components/resources/VirtualTable'
import { useNow } from '@/lib/use-now'
import type { Pod } from '@/lib/k8s/types'

/** Ordem natural (app-2 antes de app-10); um Collator compara bem mais rápido que localeCompare. */
const byName = new Intl.Collator(undefined, { numeric: true })

/** Lista de pods. Namespace vem de ?ns=; ausente = todos os namespaces. */
export function Pods() {
  const { t } = useTranslation()
  const namespace = useSearch({ from: '/pods' }).ns ?? ''
  const navigate = useNavigate()
  const [filter, setFilter] = useState('')
  const pods = usePods(namespace)
  const live = usePodsLive(namespace, pods.isSuccess)
  const now = useNow()

  const setNamespace = (ns: string) => void navigate({ to: '/pods', search: ns ? { ns } : {} })

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return (pods.data?.items ?? [])
      .filter((p) => !term || p.metadata.name.toLowerCase().includes(term) || p.metadata.namespace?.includes(term))
      .sort((a, b) => byName.compare(a.metadata.namespace ?? '', b.metadata.namespace ?? '') || byName.compare(a.metadata.name, b.metadata.name))
  }, [pods.data, filter])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">{t('nav.pods')}</h1>
          <p className="text-muted">
            {pods.data && !pods.isError ? t('pods.count', { shown: rows.length, count: pods.data.items.length }) : ' '}
          </p>
        </div>
        <LiveIndicator state={live} />
        <NamespacePicker value={namespace} onChange={setNamespace} />
        <FilterInput value={filter} onChange={setFilter} />
        <RefreshButton onClick={() => void pods.refetch()} spinning={pods.isFetching} />
      </div>

      {pods.isError ? (
        <LoadError error={pods.error} what="pods" namespace={namespace} namespaced />
      ) : (
        <PodTable pods={rows} loading={pods.isPending} showNamespace={!namespace} now={now} />
      )}
    </div>
  )
}

interface PodTableProps {
  pods: Pod[]
  loading: boolean
  showNamespace: boolean
  /** Momento da consulta; a idade é calculada em relação a ele. */
  now: number
}

function PodTable({ pods, loading, showNamespace, now }: PodTableProps) {
  const { t } = useTranslation()

  const headers = [
    t('pods.col.name'),
    ...(showNamespace ? [t('pods.col.namespace')] : []),
    t('pods.col.status'),
    t('pods.col.ready'),
    t('pods.col.restarts'),
    t('pods.col.age'),
    t('pods.col.node'),
    t('pods.col.ip'),
  ]

  return (
    <VirtualTable
      rows={pods}
      rowKey={(pod) => pod.metadata.uid}
      header={headers.map((h) => (
        <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
          {h}
        </th>
      ))}
      cells={(pod) => {
        const s = summarizePod(pod)
        return (
          <>
            <td className="px-3 py-1.5 font-medium whitespace-nowrap">
              <ObjectLink kind={kinds.pods} name={pod.metadata.name} namespace={pod.metadata.namespace} />
            </td>
            {showNamespace && <td className="px-3 py-1.5 text-muted">{pod.metadata.namespace}</td>}
            <td className="px-3 py-1.5">
              <StatusBadge severity={s.severity}>{s.status}</StatusBadge>
            </td>
            <td className="px-3 py-1.5 font-mono">
              {s.ready}/{s.total}
            </td>
            <td className={`px-3 py-1.5 font-mono ${s.restarts > 0 ? 'text-warn' : ''}`}>{s.restarts}</td>
            <td className="px-3 py-1.5 font-mono text-muted" title={pod.metadata.creationTimestamp}>
              {age(pod.metadata.creationTimestamp, now)}
            </td>
            <td className="px-3 py-1.5 text-muted">{pod.spec.nodeName ?? '—'}</td>
            <td className="px-3 py-1.5 font-mono text-muted">{pod.status.podIP ?? '—'}</td>
          </>
        )
      }}
      footer={
        <>
          {!loading && pods.length === 0 && <p className="p-6 text-center text-muted">{t('pods.empty')}</p>}
          {loading && <p className="p-6 text-center text-muted">{t('pods.loading')}</p>}
        </>
      }
    />
  )
}
