import { describe, expect, it } from 'vitest'
import { maskSecret } from './secrets'
import type { K8sObject } from './types'

const secret: K8sObject = {
  kind: 'Secret',
  metadata: {
    name: 's',
    uid: 'u',
    creationTimestamp: '',
    annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"senha":"c2VncmVkbw=="}}', outra: 'ok' },
  },
  data: { senha: 'c2VncmVkbw==' },
  stringData: { token: 'texto' },
}

describe('maskSecret', () => {
  it('esconde data, stringData e a última configuração aplicada', () => {
    const m = maskSecret(secret)
    const text = JSON.stringify(m)
    expect(text).not.toContain('c2VncmVkbw')
    expect(text).not.toContain('texto')
    expect(m.data).toEqual({ senha: '••••••' })
    expect(m.metadata.annotations?.outra).toBe('ok')
    // O original não é alterado.
    expect(secret.data?.senha).toBe('c2VncmVkbw==')
  })

  it('não mexe em outros tipos', () => {
    const cm = { ...secret, kind: 'ConfigMap' }
    expect(maskSecret(cm)).toBe(cm)
  })
})
