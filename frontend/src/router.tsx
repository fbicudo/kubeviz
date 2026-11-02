import { createRootRoute, createRoute, createRouter, type RouterHistory } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { allNavItems } from '@/components/layout/nav'
import { Overview } from '@/pages/Overview'
import { Placeholder } from '@/pages/Placeholder'

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => <Placeholder titleKey="placeholder.title" />,
})

const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Overview })

// Enquanto as telas não existem, cada item do menu aponta para um placeholder.
const sectionRoutes = allNavItems.map((item) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: item.path,
    component: () => <Placeholder titleKey={`nav.${item.id}`} />,
  }),
)

const routeTree = rootRoute.addChildren([overviewRoute, ...sectionRoutes])

export function makeRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
