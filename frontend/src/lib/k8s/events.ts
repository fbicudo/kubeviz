import type { KubeEvent } from './types'

/** Último horário em que o evento ocorreu (os campos variam entre versões da API). */
export const lastSeen = (e: KubeEvent) =>
  e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp
