import { describe, expect, it } from 'vitest'
import { parseDiscovery } from './discovery'
import { prepareDocuments } from './documents'

const discovery = parseDiscovery([
  {
    kind: 'APIGroupDiscoveryList',
    items: [
      {
        metadata: {},
        versions: [
          {
            version: 'v1',
            resources: [
              { resource: 'namespaces', scope: 'Cluster', responseKind: { kind: 'Namespace' } },
              { resource: 'configmaps', scope: 'Namespaced', responseKind: { kind: 'ConfigMap' } },
            ],
          },
        ],
      },
    ],
  },
  {
    kind: 'APIGroupDiscoveryList',
    items: [
      {
        metadata: { name: 'example.com' },
        versions: [{ version: 'v1alpha1', resources: [{ resource: 'widgets', scope: 'Namespaced', responseKind: { kind: 'Widget' } }] }],
      },
    ],
  },
])
const t = (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k)

describe('parseDiscovery', () => {
  it('indexa core, grupos e CRDs por apiVersion/kind', () => {
    expect(discovery.get('v1/ConfigMap')).toMatchObject({ group: '', resource: 'configmaps', namespaced: true })
    expect(discovery.get('v1/Namespace')?.namespaced).toBe(false)
    expect(discovery.get('example.com/v1alpha1/Widget')).toMatchObject({ group: 'example.com', resource: 'widgets' })
  })

  it('recusa respostas que não são da descoberta agregada', () => {
    expect(() => parseDiscovery([{ kind: 'APIGroupList', items: [] }])).toThrow(/descoberta agregada/)
  })
})

describe('prepareDocuments', () => {
  it('separa documentos, expande List, completa e remove namespace', () => {
    const text = `
apiVersion: v1
kind: Namespace
metadata: {name: teste, namespace: lixo}
---
---
apiVersion: v1
kind: List
items:
- {apiVersion: v1, kind: ConfigMap, metadata: {name: a}}
- {apiVersion: example.com/v1alpha1, kind: Widget, metadata: {name: w, namespace: teste}}
`
    const { docs, problems } = prepareDocuments(text, discovery, 'padrao', t)
    expect(problems).toEqual([])
    expect(docs.map((d) => d.path)).toEqual([
      '/api/v1/namespaces/teste',
      '/api/v1/namespaces/padrao/configmaps/a',
      '/apis/example.com/v1alpha1/namespaces/teste/widgets/w',
    ])
    expect(docs[0].obj.metadata.namespace).toBeUndefined()
    expect(docs[0].notes[0]).toContain('droppedNamespace')
    expect(docs[1].notes[0]).toContain('defaultedNamespace')
  })

  it('aponta problemas por documento', () => {
    const text = `apiVersion: v1\nkind: ConfigMap\nmetadata: {generateName: x-}\n---\napiVersion: v9\nkind: Nada\nmetadata: {name: n}\n---\na: [1\n---\n- lista\n`
    const { docs, problems } = prepareDocuments(text, discovery, 'padrao', t)
    expect(docs).toEqual([])
    expect(problems.map((p) => [p.index, p.message.split(' ')[0]])).toEqual([
      [1, 'applyYaml.missingName'],
      [2, 'applyYaml.unknownKind'],
      [3, expect.any(String)],
      [4, 'applyYaml.notObject'],
    ])
  })
})
