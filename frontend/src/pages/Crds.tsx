import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FilterInput, LoadError } from '@/components/resources/common'
import { LiveIndicator } from '@/components/resources/LiveIndicator'
import { ObjectLink } from '@/components/resources/ObjectLink'
import { age } from '@/lib/format'
import { servedVersion, type CrdSpec } from '@/lib/k8s/crds'
import { useK8sList, useK8sListLive } from '@/lib/k8s/queries'
import type { K8sObject } from '@/lib/k8s/types'
import { useNow } from '@/lib/use-now'

const CRD_PATH = '/apis/apiextensions.k8s.io/v1/customresourcedefinitions'
const crdKind = { group: 'apiextensions.k8s.io', version: 'v1', resource: 'customresourcedefinitions' }

/** Recursos personalizados (CRDs) instalados, com acesso aos objetos de cada um. */
export function Crds() {
  const { t } = useTranslation()
  const now = useNow()
  const [filter, setFilter] = useState('')
  const key = ['k8s', 'crds'] as const
  const list = useK8sList<K8sObject>(key, CRD_PATH)
  const live = useK8sListLive<K8sObject>(key, CRD_PATH, list.isSuccess)

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return (list.data?.items ?? [])
      .map((c) => ({ obj: c, spec: c.spec as unknown as CrdSpec }))
      .filter(({ obj, spec }) => !term || obj.metadata.name.includes(term) || spec.names.kind.toLowerCase().includes(term))
      .sort((a, b) => a.spec.group.localeCompare(b.spec.group) || a.spec.names.kind.localeCompare(b.spec.names.kind))
  }, [list.data, filter])

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">{t('nav.crds')}</h1>
        <p className="text-muted">{t('crds.subtitle')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-muted">
          {list.data ? t('resources.count', { shown: rows.length, count: list.data.items.length }) : ' '}
        </p>
        {!list.isError && <LiveIndicator state={live} />}
        <FilterInput value={filter} onChange={setFilter} />
      </div>
      {list.isError ? (
        <LoadError error={list.error} what={t('nav.crds')} namespace="" namespaced={false} />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-surface">
          <table className="w-full text-left">
            <thead className="border-b text-xs text-muted">
              <tr>
                {['kind', 'group', 'versions', 'scope', 'crd', 'age'].map((c) => (
                  <th key={c} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    {t(`crds.col.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map(({ obj, spec }) => {
                const version = servedVersion(spec)
                return (
                  <tr key={obj.metadata.uid} className="hover:bg-surface-raised">
                    <td className="px-3 py-1.5 font-medium whitespace-nowrap">
                      {version ? (
                        <Link
                          to="/list/$group/$version/$resource"
                          params={{ group: spec.group, version, resource: spec.names.plural }}
                          className="text-accent hover:underline"
                        >
                          {spec.names.kind}
                        </Link>
                      ) : (
                        spec.names.kind
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{spec.group}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{spec.versions.map((v) => v.name).join(', ')}</td>
                    <td className="px-3 py-1.5 text-muted">{t(`crds.scope.${spec.scope}`)}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      <ObjectLink kind={crdKind} name={obj.metadata.name} />
                    </td>
                    <td className="px-3 py-1.5 font-mono text-muted">{age(obj.metadata.creationTimestamp, now)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {list.isSuccess && rows.length === 0 && <p className="p-6 text-center text-muted">{t('crds.empty')}</p>}
        </div>
      )}
    </div>
  )
}
