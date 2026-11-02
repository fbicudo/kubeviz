import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useTheme } from '@/lib/theme-context'

export interface ChartSeries {
  label: string
  values: (number | null)[]
  /** Variável CSS da cor (ex.: --accent). */
  color: string
  /** Linha tracejada (referências: requests, capacidade). */
  dashed?: boolean
  /** Área preenchida sob a linha (o uso). */
  fill?: boolean
}

interface TimeSeriesChartProps {
  /** Título acessível do gráfico. */
  title: string
  /** Instantes em segundos Unix. */
  ts: number[]
  series: ChartSeries[]
  format: (v: number) => string
  height?: number
  /** Resumo para leitores de tela (média, máximo…). */
  summary: string
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Série temporal (uPlot): leve e rápida mesmo com milhares de pontos. */
export function TimeSeriesChart({ title, ts, series, format, height = 200, summary }: TimeSeriesChartProps) {
  const box = useRef<HTMLDivElement>(null)
  const { theme } = useTheme()

  useEffect(() => {
    const el = box.current
    if (!el) return
    let chart: uPlot | undefined
    let resize: ResizeObserver | undefined
    // As cores vêm do tema: espera o próximo quadro, quando a troca de tema
    // (aplicada pelo ThemeProvider depois deste efeito) já está no documento.
    const frame = requestAnimationFrame(() => {
      const grid = { stroke: css('--border'), width: 1 }
      const axis = { stroke: css('--muted'), grid, ticks: grid, font: '11px ui-monospace, monospace' }
      const opts: uPlot.Options = {
        width: el.clientWidth || 600,
        height,
        cursor: { drag: { x: false, y: false } },
        legend: { live: true },
        scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, max > 0 ? max * 1.1 : 1] } },
        axes: [
          { ...axis },
          { ...axis, size: 70, values: (_u, vals) => vals.map((v) => (v == null ? '' : format(v))) },
        ],
        series: [
          { value: (_u, v) => (v == null ? '—' : new Date(v * 1000).toLocaleString()) },
          ...series.map((s) => {
            const color = css(s.color) || s.color
            return {
              label: s.label,
              stroke: color,
              width: s.dashed ? 1.25 : 1.5,
              dash: s.dashed ? [5, 4] : undefined,
              fill: s.fill ? `color-mix(in srgb, ${color} 18%, transparent)` : undefined,
              points: { show: false },
              value: (_u: uPlot, v: number | null) => (v == null ? '—' : format(v)),
            }
          }),
        ],
      }
      const c = new uPlot(opts, [ts, ...series.map((s) => s.values)] as uPlot.AlignedData, el)
      chart = c
      resize = new ResizeObserver(() => c.setSize({ width: el.clientWidth, height }))
      resize.observe(el)
    })
    return () => {
      cancelAnimationFrame(frame)
      resize?.disconnect()
      chart?.destroy()
    }
  }, [ts, series, format, height, theme])

  return (
    <figure className="kv-chart min-w-0" aria-label={title}>
      <figcaption className="sr-only">
        {title}. {summary}
      </figcaption>
      <div ref={box} aria-hidden />
    </figure>
  )
}
