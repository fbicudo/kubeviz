// Tipos de recurso exibidos nas páginas do menu e onde cada um vive na API.

export interface ResourceKind {
  /** Identificador estável; também é a chave de tradução em `kinds.*`. */
  id: string
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
  group: string,
  version: string,
  resource: string,
  namespaced = true,
  optional = false,
): ResourceKind => ({ id, group, version, resource, namespaced, optional })

export const kinds = {
  nodes: kind('nodes', '', 'v1', 'nodes', false),
  namespaces: kind('namespaces', '', 'v1', 'namespaces', false),
  events: kind('events', '', 'v1', 'events'),
  deployments: kind('deployments', 'apps', 'v1', 'deployments'),
  statefulsets: kind('statefulsets', 'apps', 'v1', 'statefulsets'),
  daemonsets: kind('daemonsets', 'apps', 'v1', 'daemonsets'),
  replicasets: kind('replicasets', 'apps', 'v1', 'replicasets'),
  jobs: kind('jobs', 'batch', 'v1', 'jobs'),
  cronjobs: kind('cronjobs', 'batch', 'v1', 'cronjobs'),
  services: kind('services', '', 'v1', 'services'),
  endpointslices: kind('endpointslices', 'discovery.k8s.io', 'v1', 'endpointslices'),
  ingresses: kind('ingresses', 'networking.k8s.io', 'v1', 'ingresses'),
  ingressclasses: kind('ingressclasses', 'networking.k8s.io', 'v1', 'ingressclasses', false),
  gateways: kind('gateways', 'gateway.networking.k8s.io', 'v1', 'gateways', true, true),
  httproutes: kind('httproutes', 'gateway.networking.k8s.io', 'v1', 'httproutes', true, true),
  networkpolicies: kind('networkpolicies', 'networking.k8s.io', 'v1', 'networkpolicies'),
  pvcs: kind('pvcs', '', 'v1', 'persistentvolumeclaims'),
  pvs: kind('pvs', '', 'v1', 'persistentvolumes', false),
  storageclasses: kind('storageclasses', 'storage.k8s.io', 'v1', 'storageclasses', false),
  configmaps: kind('configmaps', '', 'v1', 'configmaps'),
  secrets: kind('secrets', '', 'v1', 'secrets'),
  serviceaccounts: kind('serviceaccounts', '', 'v1', 'serviceaccounts'),
  roles: kind('roles', 'rbac.authorization.k8s.io', 'v1', 'roles'),
  rolebindings: kind('rolebindings', 'rbac.authorization.k8s.io', 'v1', 'rolebindings'),
  clusterroles: kind('clusterroles', 'rbac.authorization.k8s.io', 'v1', 'clusterroles', false),
  clusterrolebindings: kind('clusterrolebindings', 'rbac.authorization.k8s.io', 'v1', 'clusterrolebindings', false),
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
