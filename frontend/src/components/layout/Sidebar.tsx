import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { navGroups, overviewItem, type NavItem } from './nav'

function NavLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { t } = useTranslation()
  const label = t(`nav.${item.id}`)
  const Icon = item.icon
  return (
    <Link
      to={item.path}
      title={collapsed ? label : undefined}
      activeOptions={{ exact: item.path === '/' }}
      className={cn(
        'flex h-7 items-center gap-2 rounded-md px-2 text-muted hover:bg-surface-raised hover:text-foreground',
        'data-[status=active]:bg-accent/10 data-[status=active]:text-accent',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {collapsed ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
    </Link>
  )
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation()
  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r bg-surface transition-[width] duration-150',
        collapsed ? 'w-12' : 'w-56',
      )}
    >
      <div className={cn('flex h-11 items-center gap-2 border-b px-3', collapsed && 'justify-center px-0')}>
        <img src="/favicon.svg" alt="" className="size-6" />
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-sm font-semibold">{t('app.name')}</div>
            <div className="text-[11px] text-subtle">{t('app.tagline')}</div>
          </div>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto p-2" aria-label="Menu principal">
        <NavLink item={overviewItem} collapsed={collapsed} />
        {navGroups.map((group) => (
          <div key={group.id} className="mt-3">
            {!collapsed && (
              <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">
                {t(`nav.groups.${group.id}`)}
              </div>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.id}>
                  <NavLink item={item} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}
