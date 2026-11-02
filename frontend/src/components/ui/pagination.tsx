import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './button'

interface PaginationProps {
  /** Página atual, começando em 1. */
  page: number
  pageSize: number
  total: number
  sizes: readonly number[]
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}

/** Navegação entre páginas de uma lista, com a escolha de itens por página. */
export function Pagination({ page, pageSize, total, sizes, onPage, onPageSize }: PaginationProps) {
  const { t } = useTranslation()
  const sizeId = useId()
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)

  return (
    <nav aria-label={t('pagination.label')} className="flex flex-wrap items-center gap-3 text-muted">
      <span aria-live="polite">{t('pagination.range', { first, last, total })}</span>
      <span className="mr-auto" />
      <label htmlFor={sizeId}>{t('pagination.perPage')}</label>
      <select
        id={sizeId}
        value={pageSize}
        onChange={(e) => onPageSize(Number(e.target.value))}
        className="h-7 rounded-md border bg-surface px-1.5 text-foreground"
      >
        {sizes.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="ghost" aria-label={t('pagination.first')} disabled={page <= 1} onClick={() => onPage(1)}>
          <ChevronsLeft />
        </Button>
        <Button size="icon" variant="ghost" aria-label={t('pagination.previous')} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </Button>
        <span className="px-1 whitespace-nowrap text-foreground">{t('pagination.page', { page, pages })}</span>
        <Button size="icon" variant="ghost" aria-label={t('pagination.next')} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight />
        </Button>
        <Button size="icon" variant="ghost" aria-label={t('pagination.last')} disabled={page >= pages} onClick={() => onPage(pages)}>
          <ChevronsRight />
        </Button>
      </div>
    </nav>
  )
}
