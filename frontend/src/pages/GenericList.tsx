import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { findByResource, useDiscovery } from '@/lib/k8s/discovery'
import { ResourceList, type ResourceSearch } from './Resources'

/** Lista de qualquer tipo do cluster (inclusive CRDs): /list/<grupo>/<versão>/<recurso>. */
export function GenericList() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { group, version, resource } = useParams({ strict: false }) as Record<string, string>
  const search = useSearch({ strict: false }) as ResourceSearch
  const discovery = useDiscovery()
  const apiGroup = group === 'core' ? '' : group
  const kind = discovery.data && findByResource(discovery.data, apiGroup, version, resource)

  if (discovery.isPending) return <p className="text-muted">{t('resources.loading')}</p>
  if (!kind) {
    return (
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">{resource}</h1>
        <p role="alert" className="text-muted">
          {discovery.isError ? discovery.error.message : t('crds.unknownType', { type: `${apiGroup ? `${apiGroup}/` : ''}${version} ${resource}` })}
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">{kind.kind}</h1>
        <p className="font-mono text-xs text-muted">
          {apiGroup ? `${apiGroup}/${version}` : version} · {resource}
        </p>
      </div>
      <ResourceList
        key={`${apiGroup}/${resource}`}
        kind={kind}
        namespace={search.ns ?? ''}
        onNamespace={(ns) => void navigate({ search: { ns: ns || undefined } } as never)}
      />
    </div>
  )
}
