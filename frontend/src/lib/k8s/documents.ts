// Preparação de YAML colado pelo usuário para aplicar: separa documentos,
// expande listas, descobre o recurso de cada tipo e completa o namespace.

import { parseAllDocuments } from 'yaml'
import { objectPath, type ResourceKind } from './catalog'
import { discoveryKey, type Discovery } from './discovery'
import type { K8sObject } from './types'

export interface PreparedDoc {
  /** Posição do documento no texto (1 = primeiro). */
  index: number
  obj: K8sObject
  kind: ResourceKind
  /** Caminho do objeto na API (sem /api/k8s). */
  path: string
  /** Avisos que não impedem aplicar (ex.: namespace completado). */
  notes: string[]
}

export interface DocProblem {
  index: number
  message: string
}

export interface PreparedBatch {
  docs: PreparedDoc[]
  problems: DocProblem[]
}

type Translate = (key: string, opts?: Record<string, unknown>) => string

/**
 * Prepara os documentos para server-side apply. Documentos vazios são
 * ignorados; listas (kind: List) são expandidas; objetos com namespace sem
 * namespace recebem `defaultNamespace`.
 */
export function prepareDocuments(text: string, discovery: Discovery, defaultNamespace: string, t: Translate): PreparedBatch {
  const docs: PreparedDoc[] = []
  const problems: DocProblem[] = []
  let index = 0

  const add = (raw: unknown, pos: number) => {
    if (raw === null || raw === undefined) return
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push({ index: pos, message: t('applyYaml.notObject') })
      return
    }
    const obj = raw as K8sObject & { items?: unknown[] }
    if (obj.kind === 'List' || (obj.kind?.endsWith('List') && Array.isArray(obj.items))) {
      for (const item of obj.items ?? []) add(item, pos)
      return
    }
    if (!obj.apiVersion || !obj.kind) {
      problems.push({ index: pos, message: t('applyYaml.missingType') })
      return
    }
    if (!obj.metadata?.name) {
      problems.push({ index: pos, message: t('applyYaml.missingName', { kind: obj.kind }) })
      return
    }
    const kind = discovery.get(discoveryKey(obj.apiVersion, obj.kind))
    if (!kind) {
      problems.push({ index: pos, message: t('applyYaml.unknownKind', { type: `${obj.apiVersion} ${obj.kind}` }) })
      return
    }
    const notes: string[] = []
    const metadata = { ...obj.metadata }
    if (kind.namespaced && !metadata.namespace) {
      metadata.namespace = defaultNamespace
      notes.push(t('applyYaml.defaultedNamespace', { ns: defaultNamespace }))
    }
    if (!kind.namespaced && metadata.namespace) {
      delete metadata.namespace
      notes.push(t('applyYaml.droppedNamespace'))
    }
    const prepared = { ...obj, metadata }
    docs.push({ index: pos, obj: prepared, kind, path: objectPath(kind, metadata.namespace ?? '', metadata.name), notes })
  }

  for (const doc of parseAllDocuments(text)) {
    index++
    if (doc.errors.length) {
      problems.push({ index, message: doc.errors[0].message.split('\n')[0] })
      continue
    }
    add(doc.toJS(), index)
  }
  return { docs, problems }
}
