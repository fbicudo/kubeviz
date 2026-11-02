// Recursos personalizados (CustomResourceDefinitions).

export interface CrdSpec {
  group: string
  scope: 'Namespaced' | 'Cluster'
  names: { kind: string; plural: string }
  versions: { name: string; served: boolean; storage: boolean }[]
}

/** Versão para listar os objetos: a de armazenamento, se servida; senão, a primeira servida. */
export function servedVersion(spec: CrdSpec): string | undefined {
  return (spec.versions.find((v) => v.storage && v.served) ?? spec.versions.find((v) => v.served))?.name
}
