// Subconjunto dos tipos da API do Kubernetes usado pela UI. Campos opcionais
// refletem o que a API pode omitir.

export interface ObjectMeta {
  name: string
  namespace?: string
  uid: string
  creationTimestamp: string
  deletionTimestamp?: string
  labels?: Record<string, string>
}

export interface List<T> {
  kind: string
  metadata: { resourceVersion?: string; continue?: string }
  items: T[]
}

/** Resposta de erro da API do Kubernetes (kind: Status). */
export interface Status {
  kind: 'Status'
  status: 'Failure'
  message: string
  reason?: string
  code: number
}

export interface ContainerState {
  waiting?: { reason?: string; message?: string }
  running?: { startedAt?: string }
  terminated?: { reason?: string; exitCode: number; signal?: number }
}

export interface ContainerStatus {
  name: string
  ready: boolean
  restartCount: number
  state?: ContainerState
}

export interface Pod {
  metadata: ObjectMeta
  spec: { nodeName?: string; containers: { name: string }[]; initContainers?: { name: string }[] }
  status: {
    phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'
    reason?: string
    podIP?: string
    containerStatuses?: ContainerStatus[]
    initContainerStatuses?: ContainerStatus[]
  }
}

export interface NodeCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
}

export interface Node {
  metadata: ObjectMeta
  status: { conditions?: NodeCondition[] }
}

export interface Namespace {
  metadata: ObjectMeta
  status: { phase?: string }
}

/** Formato Table (meta.k8s.io/v1), o mesmo usado pelo `kubectl get`. */
export interface TableColumn {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean' | 'date'
  format?: string
  description?: string
  /** 0 = coluna padrão; maior que 0 = só no modo "wide". */
  priority: number
}

export interface TableRow {
  cells: unknown[]
  /** Com includeObject=Metadata (padrão): apenas os metadados do objeto. */
  object: { metadata: ObjectMeta }
}

export interface Table {
  kind: 'Table'
  columnDefinitions: TableColumn[]
  rows: TableRow[]
  metadata: { resourceVersion?: string }
}
