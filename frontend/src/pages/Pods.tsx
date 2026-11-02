import { useNavigate, useSearch } from '@tanstack/react-router'
import { RefreshCw, Search, ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { StatusBadge } from '@/components/ui/status-badge'
import { ApiError } from '@/lib/api'
import { age } from '@/lib/format'
import { summarizePod } from '@/lib/k8s/pods'
import { useNamespaces, usePods } from '@/lib/k8s/queries'
import type { Pod } from '@/lib/k8s/types'

/** Lista de pods. Namespace vem de ?ns=; ausente = todos os namespaces. */
export function Pods() {
  const { t } = useTranslation()
  const namespace = useSearch({ from: '/pods' }).ns ?? ''
  const navigate = useNavigate()
  const [filter, setFilter] = useState('')
  const pods = usePods(namespace)

  const setNamespace = (ns: string) => void navigate({ to: '/pods', search: ns ? { ns } : {} })

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return (pods.data?.items ?? [])
      .filter((p) => !term || p.metadata.name.toLowerCase().includes(term) || p.metadata.namespace?.includes(term))
      .sort((a, b) => (a.metadata.namespace ?? '').localeCompare(b.metadata.namespace ?? '') || a.metadata.name.localeCompare(b.metadata.name))
  }, [pods.data, filter])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">{t('nav.pods')}</h1>
          <p className="text-muted">
            {pods.data && !pods.isError ? t('pods.count', { shown: rows.length, count: pods.data.items.length }) : ' '}
          </p>
        </div>
        <NamespacePicker value={namespace} onChange={setNamespace} />
        <label className="flex h-8 w-64 items-center gap-2 rounded-md border bg-surface px-2 text-muted focus-within:border-accent">
          <Search className="size-4" aria-hidden />
          <input
            className="w-full bg-transparent text-foreground outline-none placeholder:text-subtle"
            placeholder={t('pods.filter')}
            aria-label={t('pods.filter')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <Button size="icon" onClick={() => void pods.refetch()} aria-label={t('pods.refresh')} title={t('pods.refresh')}>
          <RefreshCw className={pods.isFetching ? 'animate-spin' : undefined} />
        </Button>
      </div>

      {pods.isError ? (
        <LoadError error={pods.error} namespace={namespace} />
      ) : (
        <PodTable pods={rows} loading={pods.isPending} showNamespace={!namespace} now={pods.dataUpdatedAt} />
      )}
    </div>
  )
}

/**
 * Seletor de namespace com busca. Sem permissão para listar namespaces, a
 * lista fica vazia e o usuário digita o nome (opção "Usar …").
 */
function NamespacePicker({ value, onChange }: { value: string; onChange: (ns: string) => void }) {
  const { t } = useTranslation()
  const namespaces = useNamespaces()
  const names = namespaces.data?.items.map((n) => n.metadata.name).sort() ?? []
  const options = [
    ...(namespaces.isError ? [] : [{ value: '', label: t('pods.allNamespaces') }]),
    ...names.map((n) => ({ value: n, label: n })),
  ]

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted">{t('pods.namespace')}</span>
      <Combobox
        label={t('pods.namespace')}
        value={value}
        options={options}
        onChange={onChange}
        allowCustom
        searchPlaceholder={t('pods.namespacePlaceholder')}
        emptyText={namespaces.isError ? t('pods.namespaceTypeHint') : undefined}
        className="w-52"
      >
        {value || (namespaces.isError ? <span className="text-subtle">{t('pods.namespacePlaceholder')}</span> : t('pods.allNamespaces'))}
      </Combobox>
    </div>
  )
}

function LoadError({ error, namespace }: { error: Error; namespace: string }) {
  const { t } = useTranslation()
  const forbidden = error instanceof ApiError && error.status === 403
  return (
    <div role="alert" className="flex max-w-3xl gap-3 rounded-lg border border-critical/40 bg-critical/5 p-4">
      <ShieldAlert className="mt-0.5 size-5 shrink-0 text-critical" aria-hidden />
      <div className="space-y-1">
        <div className="font-medium">
          {forbidden
            ? t('pods.forbidden', { scope: namespace || t('pods.allNamespaces').toLowerCase() })
            : t('pods.loadError')}
        </div>
        <p className="font-mono text-xs break-all text-muted">{error.message}</p>
        {forbidden && !namespace && <p className="text-muted">{t('pods.forbiddenHint')}</p>}
      </div>
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
    <div className="overflow-x-auto rounded-lg border bg-surface">
      <table className="w-full text-left">
        <thead className="border-b text-xs text-muted">
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {pods.map((pod) => {
            const s = summarizePod(pod)
            return (
              <tr key={pod.metadata.uid} className="hover:bg-surface-raised">
                <td className="px-3 py-1.5 font-medium">{pod.metadata.name}</td>
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
              </tr>
            )
          })}
        </tbody>
      </table>
      {!loading && pods.length === 0 && <p className="p-6 text-center text-muted">{t('pods.empty')}</p>}
      {loading && <p className="p-6 text-center text-muted">{t('pods.loading')}</p>}
    </div>
  )
}
