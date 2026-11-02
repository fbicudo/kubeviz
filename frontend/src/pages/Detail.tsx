import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ArrowLeft, Check, Copy, Eye, EyeOff, Pencil, SearchX } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { stringify } from 'yaml'
import { LiveIndicator } from '@/components/resources/LiveIndicator'
import { EditObject } from '@/components/editor/EditObject'
import { LoadError } from '@/components/resources/common'
import { LogsView } from '@/components/resources/LogsView'
import { ObjectLink } from '@/components/resources/ObjectLink'
import { Button } from '@/components/ui/button'
import type { Status } from '@/components/ui/stat-tile'
import { StatusBadge } from '@/components/ui/status-badge'
import { age } from '@/lib/format'
import {
  collectionPath,
  findKind,
  objectPath,
  kindOfOwner,
  kinds,
  pageOfKind,
  type ResourceKind,
} from '@/lib/k8s/catalog'
import { summarizePod } from '@/lib/k8s/pods'
import { maskSecret } from '@/lib/k8s/secrets'
import { useK8sList, useK8sListLive } from '@/lib/k8s/queries'
import type { Condition, K8sObject, KubeEvent, Pod } from '@/lib/k8s/types'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

export interface DetailSearch {
  ns?: string
  tab?: 'overview' | 'yaml' | 'events' | 'logs'
}

/** Detalhe de qualquer objeto: /view/<grupo>/<versão>/<recurso>/<nome>?ns=… */
export function Detail() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { group, version, resource, name } = useParams({ strict: false }) as Record<string, string>
  const search = useSearch({ strict: false }) as DetailSearch
  const namespace = search.ns ?? ''
  const tab = search.tab ?? 'overview'
  const apiGroup = group === 'core' ? '' : group

  const kind: ResourceKind = findKind(apiGroup, resource) ?? {
    id: resource,
    kind: resource,
    group: apiGroup,
    version,
    resource,
    namespaced: namespace !== '',
  }

  // O objeto é lido como lista filtrada pelo nome, para o watch mantê-lo atualizado.
  const path = `${collectionPath(kind, namespace)}?fieldSelector=${encodeURIComponent(`metadata.name=${name}`)}`
  const key = ['k8s', 'object', apiGroup, resource, namespace, name] as const
  const list = useK8sList<K8sObject>(key, path)
  const live = useK8sListLive<K8sObject>(key, path, list.isSuccess)
  const found = list.data?.items[0]
  // Itens de listas vêm sem apiVersion/kind; completa para o YAML.
  const obj = found && {
    apiVersion: apiGroup ? `${apiGroup}/${version}` : version,
    kind: kind.kind,
    ...found,
  }

  const page = pageOfKind(kind)
  const kindLabel = kind.id in kinds ? t(`kinds.${kind.id}`) : kind.kind

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {page && (
          <Link
            to={`/${page}` as never}
            search={(kind.namespaced && namespace ? { ns: namespace } : {}) as never}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {kindLabel}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold break-all">{name}</h1>
          {obj && <ObjectStatus obj={obj} />}
          <span className="ml-auto">{obj && <LiveIndicator state={live} />}</span>
        </div>
        <p className="text-muted">
          {kind.kind}
          {namespace && ` · ${namespace}`}
        </p>
      </div>

      {list.isError ? (
        <LoadError error={list.error} what={kindLabel} namespace={namespace} namespaced={kind.namespaced} />
      ) : list.isPending ? (
        <p className="text-muted">{t('resources.loading')}</p>
      ) : !obj ? (
        <div role="status" className="flex max-w-3xl gap-3 rounded-lg border border-dashed bg-surface p-4">
          <SearchX className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
          <div>
            <div className="font-medium">{t('detail.notFound')}</div>
            <p className="text-muted">{t('detail.notFoundHint')}</p>
          </div>
        </div>
      ) : (
        <>
          <div role="tablist" aria-label={t('detail.sections')} className="flex gap-1 border-b">
            {(kind.kind === 'Pod' ? (['overview', 'logs', 'yaml', 'events'] as const) : (['overview', 'yaml', 'events'] as const)).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() =>
                  void navigate({ search: { ns: namespace || undefined, tab: id === 'overview' ? undefined : id } } as never)
                }
                className={cn(
                  '-mb-px border-b-2 px-3 py-1.5 text-muted hover:text-foreground',
                  tab === id ? 'border-accent text-foreground' : 'border-transparent',
                )}
              >
                {t(`detail.tab.${id}`)}
              </button>
            ))}
          </div>
          {tab === 'overview' && <Overview obj={obj} kind={kind} />}
          {tab === 'yaml' && <YamlView obj={obj} path={objectPath(kind, namespace, name)} />}
          {tab === 'events' && <Events obj={obj} />}
          {tab === 'logs' && kind.kind === 'Pod' && <LogsView pod={obj} />}
        </>
      )}
    </div>
  )
}

/** Status resumido: fase, condição Ready ou status do pod. */
function ObjectStatus({ obj }: { obj: K8sObject }) {
  let text: string | undefined
  let severity: Status = 'unknown'
  if (obj.kind === 'Pod') {
    const s = summarizePod(obj as unknown as Pod)
    text = s.status
    severity = s.severity
  } else {
    const ready = (obj.status?.conditions as Condition[] | undefined)?.find((c) => c.type === 'Ready' || c.type === 'Available')
    const phase = obj.status?.phase as string | undefined
    if (ready) {
      text = ready.status === 'True' ? ready.type : `Not${ready.type}`
      severity = ready.status === 'True' ? 'ok' : 'critical'
    } else if (phase) {
      text = phase
      severity = /^(Active|Bound|Running|Succeeded)$/.test(phase) ? 'ok' : /Failed|Lost/.test(phase) ? 'critical' : 'warn'
    }
  }
  return text ? <StatusBadge severity={severity}>{text}</StatusBadge> : null
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-surface">
      <h2 className="border-b px-4 py-2 text-xs font-medium tracking-wide text-muted uppercase">{title}</h2>
      <div className="p-4">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-3 py-1">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function Chips({ items }: { items?: Record<string, string> }) {
  const { t } = useTranslation()
  const entries = Object.entries(items ?? {})
  if (entries.length === 0) return <span className="text-subtle">{t('detail.none')}</span>
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs">
          {k}={v}
        </span>
      ))}
    </div>
  )
}

function Overview({ obj, kind }: { obj: K8sObject; kind: ResourceKind }) {
  const { t } = useTranslation()
  const now = useNow()
  const m = obj.metadata
  const conditions = (obj.status?.conditions as Condition[] | undefined) ?? []
  const annotations = Object.entries(m.annotations ?? {}).filter(
    ([k]) => k !== 'kubectl.kubernetes.io/last-applied-configuration',
  )

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section title={t('detail.metadata')}>
        <dl>
          <Field label={t('detail.name')}>{m.name}</Field>
          {m.namespace && (
            <Field label={t('resources.namespace')}>
              <ObjectLink kind={kinds.namespaces} name={m.namespace} />
            </Field>
          )}
          <Field label={t('detail.created')}>
            <span title={m.creationTimestamp}>
              {age(m.creationTimestamp, now)} · {new Date(m.creationTimestamp).toLocaleString()}
            </span>
          </Field>
          <Field label="UID">
            <span className="font-mono text-xs">{m.uid}</span>
          </Field>
          <Field label={t('detail.labels')}>
            <Chips items={m.labels} />
          </Field>
          {(m.ownerReferences ?? []).length > 0 && (
            <Field label={t('detail.owners')}>
              {m.ownerReferences!.map((o) => {
                const ok = kindOfOwner(o.apiVersion, o.kind)
                return (
                  <div key={o.uid}>
                    {o.kind}{' '}
                    {ok ? (
                      <ObjectLink kind={ok} name={o.name} namespace={ok.namespaced ? m.namespace : undefined} />
                    ) : (
                      o.name
                    )}
                  </div>
                )
              })}
            </Field>
          )}
          {annotations.length > 0 && (
            <Field label={t('detail.annotations')}>
              <ul className="space-y-0.5 font-mono text-xs">
                {annotations.map(([k, v]) => (
                  <li key={k} className="break-all">
                    <span className="text-muted">{k}:</span> {v.length > 200 ? `${v.slice(0, 200)}…` : v}
                  </li>
                ))}
              </ul>
            </Field>
          )}
        </dl>
      </Section>

      {conditions.length > 0 && (
        <Section title={t('detail.conditions')}>
          <table className="w-full text-left">
            <thead className="text-xs text-muted">
              <tr>
                <th className="pb-1 font-medium">{t('detail.condType')}</th>
                <th className="pb-1 font-medium">Status</th>
                <th className="pb-1 font-medium">{t('detail.condReason')}</th>
                <th className="pb-1 font-medium">{t('detail.condSince')}</th>
              </tr>
            </thead>
            <tbody>
              {conditions.map((c) => (
                <tr key={c.type} className="align-top" title={c.message}>
                  <td className="py-1 pr-3">{c.type}</td>
                  <td className="py-1 pr-3">
                    <StatusBadge severity={c.status === 'True' ? 'ok' : c.status === 'False' ? 'warn' : 'unknown'}>
                      {c.status}
                    </StatusBadge>
                  </td>
                  <td className="py-1 pr-3">
                    {c.reason ?? '—'}
                    {c.message && <div className="text-xs text-muted">{c.message}</div>}
                  </td>
                  <td className="py-1 font-mono text-muted">{c.lastTransitionTime ? age(c.lastTransitionTime, now) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Containers obj={obj} />
      {kind.kind === 'Secret' && <SecretKeys obj={obj} />}
      {kind.kind === 'ConfigMap' && obj.data && (
        <Section title={t('detail.data')}>
          <dl>
            {Object.entries(obj.data).map(([k, v]) => (
              <Field key={k} label={k}>
                <pre className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap">{v}</pre>
              </Field>
            ))}
          </dl>
        </Section>
      )}
    </div>
  )
}

interface ContainerSpec {
  name: string
  image?: string
  ports?: { containerPort: number; protocol?: string; name?: string }[]
}

/** Containers do pod ou do template do workload. */
function Containers({ obj }: { obj: K8sObject }) {
  const { t } = useTranslation()
  const spec = obj.spec as { containers?: ContainerSpec[]; template?: { spec?: { containers?: ContainerSpec[] } }; nodeName?: string } | undefined
  const containers = spec?.containers ?? spec?.template?.spec?.containers
  if (!containers?.length) return null
  const statuses = (obj.status?.containerStatuses as Pod['status']['containerStatuses']) ?? []

  return (
    <Section title={t('detail.containers')}>
      {spec?.nodeName && (
        <p className="mb-2 text-muted">
          {t('detail.node')}:{' '}
          <ObjectLink kind={kinds.nodes} name={spec.nodeName} />
          {typeof obj.status?.podIP === 'string' && ` · IP ${obj.status.podIP}`}
        </p>
      )}
      <ul className="divide-y">
        {containers.map((c) => {
          const st = statuses.find((s) => s.name === c.name)
          const state = st?.state?.waiting?.reason ?? st?.state?.terminated?.reason ?? (st?.state?.running ? 'Running' : undefined)
          return (
            <li key={c.name} className="py-2 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                {state && (
                  <StatusBadge severity={state === 'Running' ? (st?.ready ? 'ok' : 'warn') : /BackOff|Err|Error|OOM/.test(state) ? 'critical' : 'warn'}>
                    {state}
                  </StatusBadge>
                )}
                {st && st.restartCount > 0 && <span className="text-xs text-warn">{t('detail.restarts', { count: st.restartCount })}</span>}
              </div>
              <div className="font-mono text-xs break-all text-muted">{c.image}</div>
              {c.ports?.length ? (
                <div className="text-xs text-muted">
                  {c.ports.map((p) => `${p.name ? `${p.name}:` : ''}${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ')}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function SecretKeys({ obj }: { obj: K8sObject }) {
  const { t } = useTranslation()
  const keys = Object.entries(obj.data ?? {})
  return (
    <Section title={t('detail.data')}>
      <p className="mb-2 text-xs text-muted">{t('detail.secretHidden')}</p>
      <dl>
        <Field label="Type">{obj.type ?? '—'}</Field>
        {keys.map(([k, v]) => (
          <Field key={k} label={k}>
            <span className="text-muted">{t('detail.bytes', { count: Math.floor((v.length * 3) / 4) })}</span>
          </Field>
        ))}
      </dl>
    </Section>
  )
}

function YamlView({ obj, path }: { obj: K8sObject; path: string }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [managed, setManaged] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [copied, setCopied] = useState(false)
  const isSecret = obj.kind === 'Secret'

  const text = useMemo(() => {
    let o = isSecret && !reveal ? maskSecret(obj) : obj
    if (!managed) o = { ...o, metadata: { ...o.metadata, managedFields: undefined } }
    return stringify(o, { lineWidth: 0 })
  }, [obj, managed, reveal, isSecret])

  const decoded = useMemo(() => {
    if (!isSecret || !reveal) return []
    return Object.entries(obj.data ?? {}).map(([k, v]) => {
      try {
        return [k, new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)))]
      } catch {
        return [k, t('detail.binary')]
      }
    })
  }, [obj, reveal, isSecret, t])

  if (editing) return <EditObject obj={obj} path={path} onClose={() => setEditing(false)} />

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {isSecret && (
          <Button size="sm" variant={reveal ? 'primary' : 'outline'} aria-pressed={reveal} onClick={() => setReveal((r) => !r)}>
            {reveal ? <EyeOff /> : <Eye />}
            {reveal ? t('detail.hideValues') : t('detail.showValues')}
          </Button>
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={managed} onChange={(e) => setManaged(e.target.checked)} />
          {t('detail.showManaged')}
        </label>
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => setEditing(true)}>
          <Pencil />
          {t('edit.edit')}
        </Button>
        <Button size="sm" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? t('detail.copied') : t('detail.copy')}
        </Button>
      </div>
      {decoded.length > 0 && (
        <Section title={t('detail.decoded')}>
          <dl>
            {decoded.map(([k, v]) => (
              <Field key={k} label={k}>
                <pre className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap">{v}</pre>
              </Field>
            ))}
          </dl>
        </Section>
      )}
      <pre className="max-h-[70vh] overflow-auto rounded-lg border bg-surface p-4 font-mono text-xs leading-relaxed">{text}</pre>
    </div>
  )
}

function Events({ obj }: { obj: K8sObject }) {
  const { t } = useTranslation()
  const now = useNow()
  const ns = obj.metadata.namespace ?? ''
  const selector = encodeURIComponent(`involvedObject.uid=${obj.metadata.uid}`)
  const path = `${collectionPath(kinds.events, ns)}?fieldSelector=${selector}`
  const key = ['k8s', 'events-of', obj.metadata.uid] as const
  const list = useK8sList<KubeEvent>(key, path)
  const live = useK8sListLive<KubeEvent>(key, path, list.isSuccess)

  const events = [...(list.data?.items ?? [])].sort((a, b) => lastSeen(b).localeCompare(lastSeen(a)))

  if (list.isError) return <LoadError error={list.error} what={t('kinds.events')} namespace={ns} namespaced={!!ns} />
  return (
    <div className="space-y-2">
      <div className="flex items-center">
        <span className="text-muted">{t('resources.count', { shown: events.length, count: events.length })}</span>
        <span className="ml-auto">
          <LiveIndicator state={live} />
        </span>
      </div>
      {events.length === 0 && !list.isPending ? (
        <p className="rounded-lg border bg-surface p-6 text-center text-muted">{t('detail.noEvents')}</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-surface">
          {events.map((e) => (
            <li key={e.metadata.uid} className="flex gap-3 px-4 py-2">
              <span className="w-36 shrink-0">
                <StatusBadge severity={e.type === 'Warning' ? 'warn' : 'unknown'}>{e.reason ?? e.type ?? '—'}</StatusBadge>
              </span>
              <div className="min-w-0 flex-1">
                <div className="break-words">{e.message}</div>
                <div className="text-xs text-muted">
                  {e.reportingComponent || e.source?.component}
                  {(e.count ?? e.series?.count ?? 1) > 1 && ` · ${t('detail.times', { count: e.count ?? e.series?.count })}`}
                </div>
              </div>
              <span className="font-mono text-xs whitespace-nowrap text-muted">{age(lastSeen(e), now)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const lastSeen = (e: KubeEvent) =>
  e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp
