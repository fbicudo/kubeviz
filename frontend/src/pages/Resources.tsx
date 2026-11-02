import { useNavigate, useSearch } from '@tanstack/react-router'
import { Columns3 } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FilterInput, LoadError, NamespacePicker, RefreshButton } from '@/components/resources/common'
import { Button } from '@/components/ui/button'
import type { Status } from '@/components/ui/stat-tile'
import { StatusBadge } from '@/components/ui/status-badge'
import { age } from '@/lib/format'
import { resourcePages, type ResourceKind } from '@/lib/k8s/catalog'
import { useResourceTable, useResourceTableLive } from '@/lib/k8s/queries'
import { LiveIndicator } from '@/components/resources/LiveIndicator'
import { useNow } from '@/lib/use-now'
import type { TableColumn, TableRow } from '@/lib/k8s/types'
import { cn } from '@/lib/utils'

/** Parâmetros de URL das páginas de recursos: ?ns=<namespace>&k=<tipo>. */
export interface ResourceSearch {
  ns?: string
  k?: string
}

/** Página de lista para os tipos de recurso associados a um item do menu. */
export function ResourcePage({ pageId }: { pageId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as ResourceSearch
  const kinds = resourcePages[pageId]
  const kind = kinds.find((k) => k.id === search.k) ?? kinds[0]
  const namespace = search.ns ?? ''

  const go = (next: ResourceSearch) =>
    void navigate({
      to: `/${pageId}`,
      search: {
        ns: (next.ns ?? namespace) || undefined,
        k: (next.k ?? kind.id) === kinds[0].id ? undefined : (next.k ?? kind.id),
      },
    } as never)

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">{t(`nav.${pageId}`)}</h1>
      {kinds.length > 1 && (
        <div role="tablist" aria-label={t('resources.kinds')} className="flex flex-wrap gap-1 border-b">
          {kinds.map((k) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={k.id === kind.id}
              onClick={() => go({ k: k.id })}
              className={cn(
                '-mb-px border-b-2 px-3 py-1.5 text-muted hover:text-foreground',
                k.id === kind.id ? 'border-accent text-foreground' : 'border-transparent',
              )}
            >
              {t(`kinds.${k.id}`)}
            </button>
          ))}
        </div>
      )}
      {/* key: estado de filtro e colunas recomeça ao trocar de tipo */}
      <ResourceList key={kind.id} kind={kind} namespace={namespace} onNamespace={(ns) => go({ ns })} />
    </div>
  )
}

interface ResourceListProps {
  kind: ResourceKind
  namespace: string
  onNamespace: (ns: string) => void
}

function ResourceList({ kind, namespace, onNamespace }: ResourceListProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const [wide, setWide] = useState(false)
  const table = useResourceTable(kind, namespace)
  const live = useResourceTableLive(kind, namespace, table.isSuccess)
  const now = useNow()
  const what = t(`kinds.${kind.id}`)

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return (table.data?.rows ?? []).filter(
      (r) => !term || r.object.metadata.name.toLowerCase().includes(term) || r.object.metadata.namespace?.includes(term),
    )
  }, [table.data, filter])

  const hasWide = table.data?.columnDefinitions.some((c) => c.priority > 0) ?? false

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-muted">
          {table.data && !table.isError ? t('resources.count', { shown: rows.length, count: table.data.rows.length }) : ' '}
        </p>
        {!table.isError && <LiveIndicator state={live} />}
        {kind.namespaced && <NamespacePicker value={namespace} onChange={onNamespace} />}
        <FilterInput value={filter} onChange={setFilter} />
        {hasWide && (
          <Button size="sm" variant={wide ? 'primary' : 'outline'} aria-pressed={wide} onClick={() => setWide((w) => !w)}>
            <Columns3 />
            {t('resources.wide')}
          </Button>
        )}
        <RefreshButton onClick={() => void table.refetch()} spinning={table.isFetching} />
      </div>

      {table.isError ? (
        <LoadError error={table.error} what={what} namespace={namespace} namespaced={kind.namespaced} />
      ) : (
        <DataTable
          columns={table.data?.columnDefinitions ?? []}
          rows={rows}
          wide={wide}
          showNamespace={kind.namespaced && !namespace}
          loading={table.isPending}
          now={now}
        />
      )}
    </div>
  )
}

/** Cor de valores de status conhecidos (Ready, Bound, Failed…). */
function severityOf(value: string): Status {
  const v = value.toLowerCase()
  if (/notready|fail|error|lost|crash|backoff|evicted|invalid/.test(v)) return 'critical'
  if (/pending|terminating|unknown|progressing|suspended|released/.test(v)) return 'warn'
  if (/^(ready|running|bound|active|available|complete|completed|succeeded|true)/.test(v)) return 'ok'
  return 'unknown'
}

const STATUS_COLUMNS = new Set(['Status', 'Phase'])

interface DataTableProps {
  columns: TableColumn[]
  rows: TableRow[]
  wide: boolean
  showNamespace: boolean
  loading: boolean
  /** Momento da consulta; a idade é calculada em relação a ele. */
  now: number
}

function DataTable({ columns, rows, wide, showNamespace, loading, now }: DataTableProps) {
  const { t } = useTranslation()
  const visible = columns.map((c, i) => ({ ...c, index: i })).filter((c) => wide || c.priority === 0)

  const cell = (col: TableColumn & { index: number }, row: TableRow) => {
    const value = row.cells[col.index]
    if (col.name === 'Age') {
      return (
        <span className="font-mono text-muted" title={row.object.metadata.creationTimestamp}>
          {age(row.object.metadata.creationTimestamp, now)}
        </span>
      )
    }
    if (value === null || value === undefined || value === '' || value === '<none>') {
      return <span className="text-subtle">—</span>
    }
    const text = String(value)
    if (col.type === 'date') {
      return (
        <span className="font-mono text-muted" title={text}>
          {age(text, now)}
        </span>
      )
    }
    if (STATUS_COLUMNS.has(col.name)) return <StatusBadge severity={severityOf(text)}>{text}</StatusBadge>
    if (col.type === 'integer' || col.type === 'number') return <span className="font-mono">{text}</span>
    return text
  }

  return (
    <div className="overflow-x-auto rounded-lg border bg-surface">
      <table className="w-full text-left">
        <thead className="border-b text-xs text-muted">
          <tr>
            {visible.map((c, i) => (
              <ColumnHeader key={c.name} column={c} extra={i === 0 && showNamespace ? t('resources.namespace') : undefined} />
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.object.metadata.uid} className="hover:bg-surface-raised">
              {visible.map((c, i) => (
                <Fragment key={c.name}>
                  <td className={cn('px-3 py-1.5 align-top', i === 0 ? 'font-medium whitespace-nowrap' : 'max-w-md break-words')}>
                    {cell(c, row)}
                  </td>
                  {i === 0 && showNamespace && (
                    <td className="px-3 py-1.5 align-top whitespace-nowrap text-muted">{row.object.metadata.namespace}</td>
                  )}
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && <p className="p-6 text-center text-muted">{t('resources.empty')}</p>}
      {loading && <p className="p-6 text-center text-muted">{t('resources.loading')}</p>}
    </div>
  )
}

function ColumnHeader({ column, extra }: { column: TableColumn; extra?: string }) {
  return (
    <>
      <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap" title={column.description}>
        {column.name}
      </th>
      {extra && (
        <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
          {extra}
        </th>
      )}
    </>
  )
}
