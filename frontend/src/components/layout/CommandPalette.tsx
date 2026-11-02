import * as Dialog from '@radix-ui/react-dialog'
import { useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { Box, Puzzle, Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listHref, type ResourceKind } from '@/lib/k8s/catalog'
import { useDiscovery } from '@/lib/k8s/discovery'
import { matchObjects, normalize, useSearchIndex, type ObjectHit } from '@/lib/k8s/search'
import { allNavItems, overviewItem } from './nav'

const itemClass =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 data-[selected=true]:bg-accent/12 data-[selected=true]:text-foreground'
const groupClass = '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-subtle'

const pageValue = (id: string) => `page:${id}`
const objectValue = (o: ObjectHit) => `obj:${o.kind.id}/${o.namespace ?? ''}/${o.name}`
const typeValue = (k: ResourceKind) => `type:${k.group}/${k.resource}`

/** Busca global: páginas do menu, tipos de recurso (inclusive CRDs) e objetos pelo nome. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const q = normalize(term.trim())
  const discovery = useDiscovery()
  const index = useSearchIndex(open)

  const pages = useMemo(
    () =>
      [overviewItem, ...allNavItems]
        .map((i) => ({ ...i, label: t(`nav.${i.id}`) }))
        .filter((i) => !q || normalize(i.label).includes(q) || i.id.includes(q)),
    [q, t],
  )
  const types = useMemo(() => {
    if (!q || !discovery.data) return []
    const seen = new Set<string>()
    const out: ResourceKind[] = []
    for (const k of discovery.data.values()) {
      const id = `${k.group}/${k.resource}`
      if (seen.has(id)) continue
      if (normalize(k.kind).includes(q) || k.resource.includes(q) || (k.group && k.group.includes(q))) {
        seen.add(id)
        out.push(k)
      }
    }
    return out.sort((a, b) => a.kind.length - b.kind.length || a.kind.localeCompare(b.kind)).slice(0, 8)
  }, [q, discovery.data])
  const objects = useMemo(() => (q.length >= 2 ? matchObjects(index.hits, q) : []), [q, index.hits])

  // Os resultados chegam aos poucos (objetos depois das páginas e tipos): a
  // seleção acompanha o primeiro resultado até o usuário escolher outro.
  const [chosen, setChosen] = useState('')
  const userMoved = useRef(false)
  const first = pages[0] ? pageValue(pages[0].id) : objects[0] ? objectValue(objects[0]) : types[0] ? typeValue(types[0]) : ''
  const search = (v: string) => {
    setTerm(v)
    setChosen('')
    userMoved.current = false
  }

  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) search('')
  }
  const go = (to: string, extra: { params?: Record<string, string>; search?: Record<string, string> } = {}) => {
    close(false)
    void navigate({ to, ...extra } as never)
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-[12vh] left-1/2 z-50 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border bg-surface-raised text-[13px] shadow-xl">
          <Dialog.Title className="sr-only">{t('search.title')}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('search.hint')}</Dialog.Description>
          <Command
            label={t('search.title')}
            shouldFilter={false}
            loop
            value={chosen || first}
            onValueChange={(v) => userMoved.current && setChosen(v)}
            onKeyDown={(e) => {
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) userMoved.current = true
            }}
          >
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 text-muted" aria-hidden />
              <Command.Input
                value={term}
                onValueChange={search}
                placeholder={t('search.placeholder')}
                className="h-11 flex-1 bg-transparent outline-none placeholder:text-subtle"
              />
              {index.loading && q.length >= 2 && <span className="text-xs text-muted">{t('search.loading')}</span>}
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-1" onPointerMove={() => (userMoved.current = true)}>
              <Command.Empty className="px-2 py-6 text-center text-muted">{t('search.empty')}</Command.Empty>
              {pages.length > 0 && (
                <Command.Group heading={t('search.pages')} className={groupClass}>
                  {pages.map((p) => (
                    <Command.Item key={p.id} value={pageValue(p.id)} onSelect={() => go(p.path)} className={itemClass}>
                      <p.icon className="size-4 shrink-0 text-muted" aria-hidden />
                      <span className="truncate">{p.label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {objects.length > 0 && (
                <Command.Group heading={t('search.objects')} className={groupClass}>
                  {objects.map((o) => (
                    <Command.Item
                      key={`${o.kind.id}/${o.namespace ?? ''}/${o.name}`}
                      value={objectValue(o)}
                      onSelect={() =>
                        go('/view/$group/$version/$resource/$name', {
                          params: { group: o.kind.group || 'core', version: o.kind.version, resource: o.kind.resource, name: o.name },
                          search: o.namespace ? { ns: o.namespace } : {},
                        })
                      }
                      className={itemClass}
                    >
                      <Box className="size-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 truncate font-mono">{o.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted">
                        {t(`kinds.${o.kind.id}`)}
                        {o.namespace && ` · ${o.namespace}`}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {types.length > 0 && (
                <Command.Group heading={t('search.types')} className={groupClass}>
                  {types.map((k) => (
                    <Command.Item key={`${k.group}/${k.resource}`} value={typeValue(k)} onSelect={() => go(listHref(k))} className={itemClass}>
                      <Puzzle className="size-4 shrink-0 text-muted" aria-hidden />
                      <span className="truncate">{k.kind}</span>
                      <span className="ml-auto shrink-0 font-mono text-xs text-muted">{k.group || 'core'}/{k.version}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
            <div className="border-t px-3 py-1.5 text-xs text-subtle">{t('search.hint')}</div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
