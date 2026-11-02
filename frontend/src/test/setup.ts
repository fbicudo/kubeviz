import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// O cmdk e o Radix usam APIs de layout que o jsdom não implementa.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Element.prototype.scrollIntoView ??= function () {}

// O uPlot desenha em canvas e consulta matchMedia (ausentes no jsdom): nos
// testes, um dublê guarda os dados recebidos por cada gráfico.
export const charts: { series: { label?: string }[]; data: unknown[][] }[] = []
vi.mock('uplot', () => ({
  default: class {
    constructor(opts: { series: { label?: string }[] }, data: unknown[][]) {
      charts.push({ series: opts.series, data })
    }
    setSize() {}
    destroy() {}
  },
}))

afterEach(() => {
  charts.length = 0
  cleanup()
  localStorage.clear()
})
