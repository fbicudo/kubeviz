import { createRootRoute, createRoute, createRouter, type RouterHistory } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { allNavItems } from '@/components/layout/nav'
import { Overview } from '@/pages/Overview'
import { Placeholder } from '@/pages/Placeholder'
import { ApplyYaml } from '@/pages/ApplyYaml'
import { Crds } from '@/pages/Crds'
import { AdminProviders } from '@/pages/AdminProviders'
import { AdminUsers } from '@/pages/AdminUsers'
import { Events } from '@/pages/Events'
import { GenericList } from '@/pages/GenericList'
import { Detail, type DetailSearch } from '@/pages/Detail'
import { Pods } from '@/pages/Pods'
import { ResourcePage, type ResourceSearch } from '@/pages/Resources'
import { resourcePages } from '@/lib/k8s/catalog'

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => <Placeholder titleKey="placeholder.title" />,
})

const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Overview })

const podsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pods',
  // ?ns=<namespace>; ausente = todos os namespaces.
  validateSearch: (search: Record<string, unknown>): { ns?: string } =>
    typeof search.ns === 'string' && search.ns ? { ns: search.ns } : {},
  component: Pods,
})

const validateResourceSearch = (search: Record<string, unknown>): ResourceSearch => ({
  ...(typeof search.ns === 'string' && search.ns ? { ns: search.ns } : {}),
  ...(typeof search.k === 'string' && search.k ? { k: search.k } : {}),
})

// Páginas com componente próprio (as demais do menu usam a lista genérica).
const customPages = new Set(['/pods', '/apply', '/crds', '/events'])

// Itens do menu: lista genérica quando há tipos no catálogo; placeholder para
// o que ainda não existe (métricas, uptime, assistentes).
const sectionRoutes = allNavItems
  .filter((item) => !customPages.has(item.path))
  .map((item) =>
    item.id in resourcePages
      ? createRoute({
          getParentRoute: () => rootRoute,
          path: item.path,
          validateSearch: validateResourceSearch,
          component: () => <ResourcePage pageId={item.id} />,
        })
      : createRoute({
          getParentRoute: () => rootRoute,
          path: item.path,
          component: () => <Placeholder titleKey={`nav.${item.id}`} />,
        }),
  )

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/view/$group/$version/$resource/$name',
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    ...(typeof search.ns === 'string' && search.ns ? { ns: search.ns } : {}),
    ...(search.tab === 'yaml' || search.tab === 'events' || search.tab === 'logs' || search.tab === 'terminal'
      ? { tab: search.tab }
      : {}),
  }),
  component: Detail,
})

const applyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/apply', component: ApplyYaml })
const adminUsersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/users', component: AdminUsers })
const adminProvidersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/providers', component: AdminProviders })
const crdsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/crds', component: Crds })
const eventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events',
  validateSearch: (search: Record<string, unknown>): ResourceSearch =>
    typeof search.ns === 'string' && search.ns ? { ns: search.ns } : {},
  component: Events,
})
const genericListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/list/$group/$version/$resource',
  validateSearch: (search: Record<string, unknown>): ResourceSearch =>
    typeof search.ns === 'string' && search.ns ? { ns: search.ns } : {},
  component: GenericList,
})

const routeTree = rootRoute.addChildren([overviewRoute, podsRoute, detailRoute, applyRoute, crdsRoute, genericListRoute, eventsRoute, adminUsersRoute, adminProvidersRoute, ...sectionRoutes])

export function makeRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
