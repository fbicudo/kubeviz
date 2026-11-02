import { afterEach, describe, expect, it, vi } from 'vitest'
import { kinds, listHref } from './catalog'
import { servedVersion } from './crds'
import { fetchNames, matchObjects, normalize, type ObjectHit } from './search'

afterEach(() => vi.unstubAllGlobals())

const hit = (name: string, namespace = 'demo'): ObjectHit => ({ kind: kinds.pods, name, namespace })

describe('busca global', () => {
  it('ordena nome igual, depois prefixo, depois trecho; empate pelo mais curto', () => {
    const hits = [hit('meu-web-2'), hit('web-abc'), hit('web'), hit('webhook'), hit('banco')]
    expect(matchObjects(hits, 'WEB').map((h) => h.name)).toEqual(['web', 'web-abc', 'webhook', 'meu-web-2'])
    expect(matchObjects(hits, '  ')).toEqual([])
    expect(matchObjects(hits, 'web', 2)).toHaveLength(2)
  })

  it('normaliza acentos e maiúsculas', () => {
    expect(normalize('Configuração')).toBe('configuracao')
  })

  it('pede só os metadados e ignora tipos sem permissão', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('secrets')
        ? new Response(JSON.stringify({ kind: 'Status', code: 403, message: 'forbidden' }), { status: 403 })
        : new Response(JSON.stringify({ items: [{ metadata: { name: 'web', namespace: 'demo' } }] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchNames(kinds.pods)).toEqual([{ kind: kinds.pods, name: 'web', namespace: 'demo' }])
    expect(await fetchNames(kinds.secrets)).toEqual([])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/k8s/api/v1/pods')
    expect(new Headers(init.headers).get('Accept')).toContain('as=PartialObjectMetadataList')
  })

  it('erros que não são de permissão continuam sendo erros', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    await expect(fetchNames(kinds.pods)).rejects.toThrow()
  })
})

describe('listas', () => {
  it('tipos do menu vão para a página; os demais, para a lista genérica', () => {
    expect(listHref(kinds.replicasets)).toBe('/deployments')
    expect(listHref(kinds.events)).toBe('/events')
    expect(listHref({ group: 'demo.kubeviz.dev', version: 'v1', resource: 'widgets' })).toBe('/list/demo.kubeviz.dev/v1/widgets')
    // Mesmo plural em outro grupo não é confundido com o tipo do catálogo.
    expect(listHref({ group: 'exemplo.io', version: 'v1', resource: 'services' })).toBe('/list/exemplo.io/v1/services')
  })

  it('CRDs são listados na versão de armazenamento, se servida', () => {
    const spec = (versions: { name: string; served: boolean; storage: boolean }[]) => ({
      group: 'g', scope: 'Namespaced' as const, names: { kind: 'K', plural: 'ks' }, versions,
    })
    expect(servedVersion(spec([{ name: 'v1beta1', served: true, storage: false }, { name: 'v1', served: true, storage: true }]))).toBe('v1')
    expect(servedVersion(spec([{ name: 'v2', served: true, storage: false }, { name: 'v1', served: false, storage: true }]))).toBe('v2')
    expect(servedVersion(spec([{ name: 'v1', served: false, storage: true }]))).toBeUndefined()
  })
})
