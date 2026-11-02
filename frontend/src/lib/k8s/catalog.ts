// Tipos de recurso exibidos nas páginas do menu e onde cada um vive na API.

export interface ResourceKind {
  /** Identificador estável; também é a chave de tradução em `kinds.*`. */
  id: string
  /** Nome do tipo na API (campo `kind`), ex.: "Deployment". */
  kind: string
  /** Grupo da API; vazio = grupo core (`/api/v1`). */
  group: string
  version: string
  /** Nome no plural usado na URL da API. */
  resource: string
  namespaced: boolean
  /** Recurso que pode não existir no cluster (ex.: Gateway API). */
  optional?: boolean
}

const kind = (
  id: string,
  kindName: string,
  group: string,
  version: string,
  resource: string,
  namespaced = true,
  optional = false,
): ResourceKind => ({ id, kind: kindName, group, version, resource, namespaced, optional })

export const kinds = {
  pods: kind('pods', 'Pod', '', 'v1', 'pods'),
  nodes: kind('nodes', 'Node', '', 'v1', 'nodes', false),
  namespaces: kind('namespaces', 'Namespace', '', 'v1', 'namespaces', false),
  events: kind('events', 'Event', '', 'v1', 'events'),
  deployments: kind('deployments', 'Deployment', 'apps', 'v1', 'deployments'),
  statefulsets: kind('statefulsets', 'StatefulSet', 'apps', 'v1', 'statefulsets'),
  daemonsets: kind('daemonsets', 'DaemonSet', 'apps', 'v1', 'daemonsets'),
  replicasets: kind('replicasets', 'ReplicaSet', 'apps', 'v1', 'replicasets'),
  jobs: kind('jobs', 'Job', 'batch', 'v1', 'jobs'),
  cronjobs: kind('cronjobs', 'CronJob', 'batch', 'v1', 'cronjobs'),
  services: kind('services', 'Service', '', 'v1', 'services'),
  endpointslices: kind('endpointslices', 'EndpointSlice', 'discovery.k8s.io', 'v1', 'endpointslices'),
  ingresses: kind('ingresses', 'Ingress', 'networking.k8s.io', 'v1', 'ingresses'),
  ingressclasses: kind('ingressclasses', 'IngressClass', 'networking.k8s.io', 'v1', 'ingressclasses', false),
  gateways: kind('gateways', 'Gateway', 'gateway.networking.k8s.io', 'v1', 'gateways', true, true),
  httproutes: kind('httproutes', 'HTTPRoute', 'gateway.networking.k8s.io', 'v1', 'httproutes', true, true),
  networkpolicies: kind('networkpolicies', 'NetworkPolicy', 'networking.k8s.io', 'v1', 'networkpolicies'),
  pvcs: kind('pvcs', 'PersistentVolumeClaim', '', 'v1', 'persistentvolumeclaims'),
  pvs: kind('pvs', 'PersistentVolume', '', 'v1', 'persistentvolumes', false),
  storageclasses: kind('storageclasses', 'StorageClass', 'storage.k8s.io', 'v1', 'storageclasses', false),
  configmaps: kind('configmaps', 'ConfigMap', '', 'v1', 'configmaps'),
  secrets: kind('secrets', 'Secret', '', 'v1', 'secrets'),
  serviceaccounts: kind('serviceaccounts', 'ServiceAccount', '', 'v1', 'serviceaccounts'),
  roles: kind('roles', 'Role', 'rbac.authorization.k8s.io', 'v1', 'roles'),
  rolebindings: kind('rolebindings', 'RoleBinding', 'rbac.authorization.k8s.io', 'v1', 'rolebindings'),
  clusterroles: kind('clusterroles', 'ClusterRole', 'rbac.authorization.k8s.io', 'v1', 'clusterroles', false),
  clusterrolebindings: kind('clusterrolebindings', 'ClusterRoleBinding', 'rbac.authorization.k8s.io', 'v1', 'clusterrolebindings', false),
} satisfies Record<string, ResourceKind>

/**
 * Páginas do menu atendidas pela lista genérica e os tipos de cada uma. Com
 * mais de um tipo, a página mostra abas. Pods têm página própria.
 */
export const resourcePages: Record<string, ResourceKind[]> = {
  nodes: [kinds.nodes],
  namespaces: [kinds.namespaces],
  events: [kinds.events],
  deployments: [kinds.deployments, kinds.replicasets],
  statefulsets: [kinds.statefulsets],
  daemonsets: [kinds.daemonsets],
  jobs: [kinds.jobs, kinds.cronjobs],
  services: [kinds.services, kinds.endpointslices],
  ingresses: [kinds.ingresses, kinds.ingressclasses, kinds.gateways, kinds.httproutes],
  networkpolicies: [kinds.networkpolicies],
  pvcs: [kinds.pvcs, kinds.pvs],
  storageclasses: [kinds.storageclasses],
  configmaps: [kinds.configmaps],
  secrets: [kinds.secrets],
  rbac: [kinds.serviceaccounts, kinds.roles, kinds.rolebindings, kinds.clusterroles, kinds.clusterrolebindings],
}

/** Caminho da coleção na API; `namespace` vazio = todos os namespaces. */
export function collectionPath(k: ResourceKind, namespace: string): string {
  const base = k.group ? `/apis/${k.group}/${k.version}` : `/api/${k.version}`
  return k.namespaced && namespace
    ? `${base}/namespaces/${encodeURIComponent(namespace)}/${k.resource}`
    : `${base}/${k.resource}`
}

/** Caminho de um objeto na API. */
export function objectPath(k: ResourceKind, namespace: string, name: string): string {
  return `${collectionPath(k, namespace)}/${encodeURIComponent(name)}`
}

const allKinds: ResourceKind[] = Object.values(kinds)

/** Tipo do catálogo a partir do grupo e do recurso (plural). */
export function findKind(group: string, resource: string): ResourceKind | undefined {
  return allKinds.find((k) => k.group === group && k.resource === resource)
}

/** Tipo do catálogo de um ownerReference (apiVersion + kind). */
export function kindOfOwner(apiVersion: string, kindName: string): ResourceKind | undefined {
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : ''
  return allKinds.find((k) => k.group === group && k.kind === kindName)
}

/** Página do menu que lista o tipo (para o link "voltar"). */
export function pageOfKind(k: ResourceKind): string | undefined {
  if (k.id === 'pods') return 'pods'
  return Object.entries(resourcePages).find(([, ks]) => ks.some((x) => x.id === k.id))?.[0]
}

/**
 * Endereço da página de detalhe: /view/<grupo>/<versão>/<recurso>/<nome>?ns=…
 * O grupo core aparece como "core".
 */
export function detailHref(k: Pick<ResourceKind, 'group' | 'version' | 'resource'>, name: string, namespace?: string) {
  const path = `/view/${k.group || 'core'}/${k.version}/${k.resource}/${encodeURIComponent(name)}`
  return namespace ? `${path}?ns=${encodeURIComponent(namespace)}` : path
}
