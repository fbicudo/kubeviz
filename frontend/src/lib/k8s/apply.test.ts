import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplyError, applyYaml, cleanForEdit, lineDiff, yamlProblems } from './apply'
import type { K8sObject } from './types'

afterEach(() => vi.unstubAllGlobals())

describe('cleanForEdit', () => {
  it('remove campos mantidos pelo cluster e preserva o resto', () => {
    const obj: K8sObject = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'web',
        namespace: 'demo',
        uid: 'u',
        resourceVersion: '9',
        creationTimestamp: 'x',
        managedFields: [{}],
        labels: { app: 'web' },
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}', nota: 'fica' },
      },
      spec: { replicas: 2 },
      status: { readyReplicas: 2 },
    }
    const c = cleanForEdit(obj)
    expect(c).toEqual({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'demo', labels: { app: 'web' }, annotations: { nota: 'fica' } },
      spec: { replicas: 2 },
    })
    expect(obj.status).toBeDefined() // não altera o original
  })

  it('usa a mesma ordem de chaves, qualquer que seja a ordem de origem', () => {
    const a = cleanForEdit({ kind: 'X', apiVersion: 'v1', spec: {}, metadata: { name: 'n', uid: 'u', creationTimestamp: '' } })
    expect(Object.keys(a)).toEqual(['apiVersion', 'kind', 'metadata', 'spec'])
  })
})

describe('yamlProblems', () => {
  it('aponta a linha do erro de sintaxe', () => {
    expect(yamlProblems('a: 1\nb: [2\n')[0].line).toBeGreaterThanOrEqual(2)
    expect(yamlProblems('a: 1\n')).toEqual([])
  })
})

describe('ApplyError.unknownFields', () => {
  it('reconhece os dois formatos de campo desconhecido', () => {
    const ssa = new ApplyError(500, 'failed to create typed patch object (demo/web; apps/v1, Kind=Deployment): .spec.replcas: field not declared in schema')
    expect(ssa.unknownFields).toEqual(['.spec.replcas'])
    const strict = new ApplyError(400, 'strict decoding error: unknown field "spec.template.spec.contaners"')
    expect(strict.unknownFields).toEqual(['spec.template.spec.contaners'])
    expect(new ApplyError(403, 'forbidden').unknownFields).toEqual([])
  })
})

describe('lineDiff', () => {
  it('marca linhas adicionadas e removidas', () => {
    const d = lineDiff('a: 1\nb: 2\n', 'a: 1\nb: 3\n')
    expect(d).toEqual([
      { kind: 'same', text: 'a: 1' },
      { kind: 'remove', text: 'b: 2' },
      { kind: 'add', text: 'b: 3' },
    ])
  })
})

describe('applyYaml', () => {
  it('faz server-side apply com validação estrita e dry-run', async () => {
    const fetchMock = vi.fn(async () => new Response('{"kind":"Deployment"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await applyYaml({ path: '/apis/apps/v1/namespaces/demo/deployments/web', yaml: 'kind: Deployment', dryRun: true })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/k8s/apis/apps/v1/namespaces/demo/deployments/web?')
    expect(url).toContain('fieldManager=kubeviz')
    expect(url).toContain('fieldValidation=Strict')
    expect(url).toContain('dryRun=All')
    expect(url).not.toContain('force')
    expect(init.method).toBe('PATCH')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/apply-patch+yaml')
  })

  it('erro do cluster vira ApplyError com causas; 409 é conflito', async () => {
    const status = {
      kind: 'Status',
      reason: 'Conflict',
      message: 'Apply failed with 1 conflict',
      details: { causes: [{ reason: 'FieldManagerConflict', field: '.spec.replicas', message: 'conflict with "kubectl"' }] },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 409 })))
    const err = await applyYaml({ path: '/x', yaml: '', dryRun: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApplyError)
    expect((err as ApplyError).isConflict).toBe(true)
    expect((err as ApplyError).causes[0].field).toBe('.spec.replicas')
  })
})
