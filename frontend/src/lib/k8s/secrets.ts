import type { K8sObject } from './types'

/** Valores de Secrets substituídos por um marcador até o usuário pedir. */
export function maskSecret(obj: K8sObject): K8sObject {
  if (obj.kind !== 'Secret') return obj
  const mask = (d?: Record<string, string>) => d && Object.fromEntries(Object.keys(d).map((k) => [k, '••••••']))
  const annotations = { ...obj.metadata.annotations }
  // last-applied-configuration pode conter os valores em texto.
  if (annotations['kubectl.kubernetes.io/last-applied-configuration']) {
    annotations['kubectl.kubernetes.io/last-applied-configuration'] = '••••••'
  }
  return {
    ...obj,
    metadata: { ...obj.metadata, annotations },
    data: mask(obj.data),
    stringData: mask(obj.stringData),
  }
}
