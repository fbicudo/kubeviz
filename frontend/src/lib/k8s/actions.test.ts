import { afterEach, describe, expect, it, vi } from 'vitest'
import { canI, deploymentRevisions, deleteObject, patchObject, restartBody, rollbackPatch, scaleBody } from './actions'
import type { K8sObject } from './types'

afterEach(() => vi.unstubAllGlobals())

const meta = (name: string, extra: Partial<K8sObject['metadata']> = {}) => ({ name, uid: name, creationTimestamp: '', ...extra })

describe('ações', () => {
  it('canI envia uma SelfSubjectAccessReview e lê status.allowed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: { allowed: true } })))
    vi.stubGlobal('fetch', fetchMock)
    const ok = await canI({ verb: 'patch', group: 'apps', resource: 'deployments', subresource: 'scale', namespace: 'demo', name: 'web' })
    expect(ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/k8s/apis/authorization.k8s.io/v1/selfsubjectaccessreviews')
    expect(JSON.parse(String(init.body)).spec.resourceAttributes).toMatchObject({ verb: 'patch', subresource: 'scale' })
  })

  it('canI nega em caso de erro', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    expect(await canI({ verb: 'delete', group: '', resource: 'pods' })).toBe(false)
  })

  it('patch e exclusão usam o gerenciador e a propagação corretos', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await patchObject('/apis/apps/v1/namespaces/demo/deployments/web/scale', scaleBody(3), 'merge')
    await deleteObject('/api/v1/namespaces/demo/pods/p')
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0][0]).toBe('/api/k8s/apis/apps/v1/namespaces/demo/deployments/web/scale?fieldManager=kubeviz')
    expect(new Headers(calls[0][1].headers).get('Content-Type')).toBe('application/merge-patch+json')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ spec: { replicas: 3 } })
    expect(calls[1][0]).toBe('/api/k8s/api/v1/namespaces/demo/pods/p')
    expect(calls[1][1].method).toBe('DELETE')
    // O backend recusa escrita sem JSON (CSRF): o DELETE precisa do cabeçalho.
    expect(new Headers(calls[1][1].headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({ kind: 'DeleteOptions', propagationPolicy: 'Background' })
  })

  it('reiniciar usa a mesma anotação do kubectl rollout restart', () => {
    const b = restartBody(new Date('2026-11-02T12:00:00Z'))
    expect(b.spec.template.metadata.annotations).toEqual({ 'kubectl.kubernetes.io/restartedAt': '2026-11-02T12:00:00.000Z' })
  })

  it('revisões vêm dos ReplicaSets do Deployment, da mais nova para a mais antiga', () => {
    const dep: K8sObject = { metadata: meta('web', { annotations: { 'deployment.kubernetes.io/revision': '3' } }) }
    const rs = (n: number, owner = 'web', image = `nginx:1.${n}`): K8sObject => ({
      metadata: meta(`web-${n}`, {
        annotations: { 'deployment.kubernetes.io/revision': String(n) },
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: owner, uid: owner }],
      }),
      spec: { template: { metadata: { labels: { app: 'web', 'pod-template-hash': 'abc' } }, spec: { containers: [{ name: 'c', image }] } } },
    })
    const revs = deploymentRevisions(dep, [rs(1), rs(3), rs(2), rs(9, 'outro')])
    expect(revs.map((r) => [r.revision, r.current])).toEqual([[3, true], [2, false], [1, false]])
    expect(revs[1].images).toEqual(['nginx:1.2'])

    const patch = rollbackPatch(revs[1].replicaSet)
    expect(patch[0]).toMatchObject({ op: 'replace', path: '/spec/template' })
    expect(patch[0].value.metadata?.labels).toEqual({ app: 'web' })
    // O ReplicaSet original não é alterado.
    expect((revs[1].replicaSet.spec as { template: { metadata: { labels: Record<string, string> } } }).template.metadata.labels['pod-template-hash']).toBe('abc')
  })
})
