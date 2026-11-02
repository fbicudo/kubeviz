import { PackageX, RefreshCw, Search, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { ApiError } from '@/lib/api'
import { useNamespaces } from '@/lib/k8s/queries'

/**
 * Seletor de namespace com busca. Sem permissão para listar namespaces, a
 * lista fica vazia e o usuário digita o nome (opção "Usar …").
 */
export function NamespacePicker({ value, onChange }: { value: string; onChange: (ns: string) => void }) {
  const { t } = useTranslation()
  const namespaces = useNamespaces()
  const names = namespaces.data?.items.map((n) => n.metadata.name).sort() ?? []
  const options = [
    ...(namespaces.isError ? [] : [{ value: '', label: t('resources.allNamespaces') }]),
    ...names.map((n) => ({ value: n, label: n })),
  ]

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted">{t('resources.namespace')}</span>
      <Combobox
        label={t('resources.namespace')}
        value={value}
        options={options}
        onChange={onChange}
        allowCustom
        searchPlaceholder={t('resources.namespacePlaceholder')}
        emptyText={namespaces.isError ? t('resources.namespaceTypeHint') : undefined}
        className="w-52"
      >
        {value ||
          (namespaces.isError ? (
            <span className="text-subtle">{t('resources.namespacePlaceholder')}</span>
          ) : (
            t('resources.allNamespaces')
          ))}
      </Combobox>
    </div>
  )
}

export function FilterInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  return (
    <label className="flex h-8 w-64 items-center gap-2 rounded-md border bg-surface px-2 text-muted focus-within:border-accent">
      <Search className="size-4" aria-hidden />
      <input
        className="w-full bg-transparent text-foreground outline-none placeholder:text-subtle"
        placeholder={t('resources.filter')}
        aria-label={t('resources.filter')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

export function RefreshButton({ onClick, spinning }: { onClick: () => void; spinning: boolean }) {
  const { t } = useTranslation()
  return (
    <Button size="icon" onClick={onClick} aria-label={t('resources.refresh')} title={t('resources.refresh')}>
      <RefreshCw className={spinning ? 'animate-spin' : undefined} />
    </Button>
  )
}

interface LoadErrorProps {
  error: Error
  /** Nome do tipo no plural, em minúsculas ("pods", "deployments"). */
  what: string
  /** Namespace consultado; vazio = todos (ou recurso sem namespace). */
  namespace: string
  namespaced: boolean
}

/** Erro ao listar: sem permissão (403), não instalado (404) ou outro. */
export function LoadError({ error, what, namespace, namespaced }: LoadErrorProps) {
  const { t } = useTranslation()
  const status = error instanceof ApiError ? error.status : 0

  if (status === 404) {
    return (
      <div role="status" className="flex max-w-3xl gap-3 rounded-lg border border-dashed bg-surface p-4">
        <PackageX className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
        <div className="space-y-1">
          <div className="font-medium">{t('resources.notInstalled', { what })}</div>
          <p className="text-muted">{t('resources.notInstalledHint')}</p>
        </div>
      </div>
    )
  }

  const forbidden = status === 403
  const scope = namespace || t('resources.allNamespaces').toLowerCase()
  return (
    <div role="alert" className="flex max-w-3xl gap-3 rounded-lg border border-critical/40 bg-critical/5 p-4">
      <ShieldAlert className="mt-0.5 size-5 shrink-0 text-critical" aria-hidden />
      <div className="space-y-1">
        <div className="font-medium">
          {!forbidden
            ? t('resources.loadError', { what })
            : namespaced
              ? t('resources.forbidden', { what, scope })
              : t('resources.forbiddenCluster', { what })}
        </div>
        <p className="font-mono text-xs break-all text-muted">{error.message}</p>
        {forbidden && namespaced && !namespace && <p className="text-muted">{t('resources.forbiddenHint')}</p>}
      </div>
    </div>
  )
}
