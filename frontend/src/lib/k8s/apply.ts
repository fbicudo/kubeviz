// Edição de objetos com server-side apply (o mesmo de `kubectl apply --server-side`).
//
// Validação = dry-run no servidor com fieldValidation=Strict: o próprio cluster
// confere o objeto contra o seu esquema (inclusive de CRDs) e recusa campos
// desconhecidos. Conflitos de dono de campo (outro gerenciador controla o campo)
// voltam como 409 e podem ser forçados explicitamente.

import { diffLines } from 'diff'
import { parseAllDocuments, stringify } from 'yaml'
import { sessionKey } from '@/lib/queries'
import type { QueryClient } from '@tanstack/react-query'
import type { K8sObject } from './types'

/** Gerenciador de campos registrado pelo KubeViz no cluster. */
export const FIELD_MANAGER = 'kubeviz'

const SERVER_FIELDS = ['uid', 'resourceVersion', 'creationTimestamp', 'generation', 'managedFields', 'selfLink', 'deletionTimestamp', 'deletionGracePeriodSeconds']

/** Objeto sem os campos mantidos pelo cluster (status, uid, managedFields…). */
export function cleanForEdit(obj: K8sObject): K8sObject {
  const metadata: Record<string, unknown> = { ...obj.metadata }
  for (const f of SERVER_FIELDS) delete metadata[f]
  const annotations = { ...(obj.metadata.annotations ?? {}) }
  delete annotations['kubectl.kubernetes.io/last-applied-configuration']
  if (Object.keys(annotations).length) metadata.annotations = annotations
  else delete metadata.annotations
  // Ordem canônica (apiVersion, kind, metadata, resto), para o diff não acusar
  // mudanças só porque o servidor devolve as chaves em outra ordem.
  const rest: Record<string, unknown> = { ...obj }
  delete rest.apiVersion
  delete rest.kind
  delete rest.metadata
  delete rest.status
  return { apiVersion: obj.apiVersion, kind: obj.kind, metadata, ...rest } as unknown as K8sObject
}

export const toYaml = (obj: unknown) => stringify(obj, { lineWidth: 0 })

export interface YamlProblem {
  message: string
  line?: number
}

/** Erros de sintaxe YAML, com a linha (1 = primeira). */
export function yamlProblems(text: string): YamlProblem[] {
  const out: YamlProblem[] = []
  for (const doc of parseAllDocuments(text)) {
    for (const e of doc.errors) out.push({ message: e.message.split('\n')[0], line: e.linePos?.[0].line })
  }
  return out
}

export interface ApplyCause {
  field?: string
  message: string
  reason?: string
}

/** Erro devolvido pelo cluster ao aplicar. */
export class ApplyError extends Error {
  readonly status: number
  readonly reason: string
  readonly causes: ApplyCause[]

  constructor(status: number, message: string, reason = '', causes: ApplyCause[] = []) {
    super(message)
    this.status = status
    this.reason = reason
    this.causes = causes
  }

  /**
   * Campos que o esquema do cluster não conhece (validação estrita), ex.:
   * ".spec.replcas". O formato da mensagem varia entre versões da API.
   */
  get unknownFields(): string[] {
    const text = [this.message, ...this.causes.map((c) => c.message)].join('\n')
    const found = [
      ...[...text.matchAll(/([.\w[\]-]+): field not declared in schema/g)].map((m) => m[1]),
      ...[...text.matchAll(/unknown field "([^"]+)"/g)].map((m) => m[1]),
    ]
    return [...new Set(found)]
  }

  /** Conflito de dono de campo: pode ser resolvido forçando. */
  get isConflict() {
    return this.status === 409 && this.reason === 'Conflict'
  }
}

interface ApplyOptions {
  /** Caminho do objeto na API, sem o prefixo /api/k8s. */
  path: string
  yaml: string
  dryRun: boolean
  force?: boolean
}

/** Server-side apply de um objeto. Devolve o objeto resultante. */
export async function applyYaml({ path, yaml, dryRun, force }: ApplyOptions, qc?: QueryClient): Promise<K8sObject> {
  const params = new URLSearchParams({ fieldManager: FIELD_MANAGER, fieldValidation: 'Strict' })
  if (dryRun) params.set('dryRun', 'All')
  if (force) params.set('force', 'true')

  const res = await fetch(`/api/k8s${path}?${params}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/apply-patch+yaml', Accept: 'application/json' },
    body: yaml,
  })
  const body = (await res.json().catch(() => ({}))) as {
    message?: string
    error?: string
    reason?: string
    details?: { causes?: ApplyCause[] }
  }
  if (res.status === 401 && qc) void qc.invalidateQueries({ queryKey: sessionKey })
  if (!res.ok) {
    throw new ApplyError(res.status, body.message ?? body.error ?? res.statusText, body.reason, body.details?.causes ?? [])
  }
  return body as unknown as K8sObject
}

export interface DiffLine {
  kind: 'add' | 'remove' | 'same'
  text: string
}

/** Diff por linhas entre dois textos. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const part of diffLines(before, after)) {
    const kind = part.added ? 'add' : part.removed ? 'remove' : 'same'
    const lines = part.value.replace(/\n$/, '').split('\n')
    for (const text of lines) out.push({ kind, text })
  }
  return out
}
