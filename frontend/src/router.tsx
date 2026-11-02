import { createRootRoute, createRoute, createRouter, type RouterHistory } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { allNavItems } from '@/components/layout/nav'
import { Overview } from '@/pages/Overview'
import { Placeholder } from '@/pages/Placeholder'
import { Pods } from '@/pages/Pods'

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

const implemented = new Set(['/pods'])

// Enquanto as telas não existem, cada item do menu aponta para um placeholder.
const sectionRoutes = allNavItems
  .filter((item) => !implemented.has(item.path))
  .map((item) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: item.path,
      component: () => <Placeholder titleKey={`nav.${item.id}`} />,
    }),
  )

const routeTree = rootRoute.addChildren([overviewRoute, podsRoute, ...sectionRoutes])

export function makeRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
