import {
  Activity,
  Boxes,
  Database,
  FilePlus2,
  FileCog,
  Gauge,
  KeySquare,
  KeyRound,
  LayoutDashboard,
  Layers,
  ListChecks,
  Network,
  Puzzle,
  Server,
  Shield,
  Shuffle,
  Timer,
  UserCog,
  Wand2,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  /** Chave de tradução em `nav.*` e segmento da URL. */
  id: string
  path: string
  icon: LucideIcon
}

export interface NavGroup {
  id: string
  items: NavItem[]
}

const item = (id: string, icon: LucideIcon): NavItem => ({ id, path: `/${id}`, icon })

/** Menu principal. As rotas são geradas a partir desta lista. */
export const navGroups: NavGroup[] = [
  {
    id: 'cluster',
    items: [item('nodes', Server), item('namespaces', Layers), item('events', ListChecks), item('crds', Puzzle)],
  },
  {
    id: 'workloads',
    items: [
      item('pods', Boxes),
      item('deployments', Boxes),
      item('statefulsets', Boxes),
      item('daemonsets', Boxes),
      item('jobs', Timer),
    ],
  },
  {
    id: 'network',
    items: [item('services', Network), item('ingresses', Shuffle), item('networkpolicies', Shield)],
  },
  { id: 'storage', items: [item('pvcs', Database), item('storageclasses', Database)] },
  {
    id: 'config',
    items: [item('configmaps', FileCog), item('secrets', KeyRound), item('rbac', Shield)],
  },
  { id: 'observability', items: [item('metrics', Gauge), item('uptime', Activity)] },
  { id: 'tools', items: [item('apply', FilePlus2), item('wizards', Wand2)] },
]

export const overviewItem: NavItem = { id: 'overview', path: '/', icon: LayoutDashboard }

export const allNavItems = navGroups.flatMap((g) => g.items)

/** Administração do KubeViz: só aparece para administradores (modo local). */
export const adminGroup: NavGroup = {
  id: 'admin',
  items: [
    { id: 'adminUsers', path: '/admin/users', icon: UserCog },
    { id: 'adminProviders', path: '/admin/providers', icon: KeySquare },
  ],
}
