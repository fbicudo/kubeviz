import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A partir de quantas linhas só as visíveis vão para a página. */
export const VIRTUALIZE_FROM = 200

/** Altura estimada de uma linha (px); a real é medida ao desenhar. */
const ROW_HEIGHT = 33

interface VirtualTableProps<R> {
  rows: R[]
  rowKey: (row: R) => string
  /** Células do cabeçalho (<th>). */
  header: ReactNode
  /** Células de uma linha (<td>). */
  cells: (row: R) => ReactNode
  /** Mensagens abaixo da tabela (vazia, carregando). */
  footer?: ReactNode
}

/**
 * Tabela que, com muitas linhas, desenha só as visíveis (e uma margem): com
 * 5.000 pods a página continua leve. Nesse caso a tabela tem rolagem própria,
 * com o cabeçalho fixo; leitores de tela recebem o total em aria-rowcount.
 */
export function VirtualTable<R>({ rows, rowKey, header, cells, footer }: VirtualTableProps<R>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtual = rows.length >= VIRTUALIZE_FROM
  // O React Compiler não memoiza este componente (as funções do virtualizer
  // mudam a cada rolagem); é o comportamento esperado.
  // eslint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => rowKey(rows[i]),
    overscan: 20,
  })

  const items = virtualizer.getVirtualItems()
  const shown = virtual ? items.map((it) => ({ row: rows[it.index], index: it.index })) : rows.map((row, index) => ({ row, index }))
  const before = virtual ? (items[0]?.start ?? 0) : 0
  const after = virtual ? virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0) : 0

  return (
    <div
      ref={scrollRef}
      className={cn('overflow-x-auto rounded-lg border bg-surface', virtual && 'max-h-[calc(100dvh-10rem)] min-h-80 overflow-y-auto')}
    >
      <table className="w-full text-left" aria-rowcount={rows.length + 1}>
        <thead className={cn('border-b text-xs text-muted', virtual && 'sticky top-0 z-10 bg-surface shadow-[0_1px_0_var(--color-border)]')}>
          <tr aria-rowindex={1}>{header}</tr>
        </thead>
        <tbody className="divide-y">
          {before > 0 && <tr aria-hidden style={{ height: before }} />}
          {shown.map(({ row, index }) => (
            <tr
              key={rowKey(row)}
              data-index={index}
              ref={virtual ? virtualizer.measureElement : undefined}
              aria-rowindex={index + 2}
              className="hover:bg-surface-raised"
            >
              {cells(row)}
            </tr>
          ))}
          {after > 0 && <tr aria-hidden style={{ height: after }} />}
        </tbody>
      </table>
      {footer}
    </div>
  )
}
