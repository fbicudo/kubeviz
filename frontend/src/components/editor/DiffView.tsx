import { useTranslation } from 'react-i18next'
import type { DiffLine } from '@/lib/k8s/apply'
import { cn } from '@/lib/utils'

const CONTEXT = 3

/** Diff unificado; trechos iguais longos aparecem resumidos. */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const { t } = useTranslation()
  // Marca as linhas iguais que ficam visíveis (perto de uma mudança).
  const changed = lines.map((l) => l.kind !== 'same')
  const visible = lines.map((_, i) => changed.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(Boolean))

  const out: React.ReactNode[] = []
  let hidden = 0
  lines.forEach((l, i) => {
    if (!visible[i]) {
      hidden++
      return
    }
    if (hidden) {
      out.push(
        <div key={`h${i}`} className="px-3 text-subtle select-none">
          {t('edit.sameLines', { count: hidden })}
        </div>,
      )
      hidden = 0
    }
    out.push(
      <div
        key={i}
        className={cn(
          'px-3 whitespace-pre-wrap',
          l.kind === 'add' && 'bg-ok/12 text-ok',
          l.kind === 'remove' && 'bg-critical/12 text-critical',
        )}
      >
        <span className="mr-2 select-none" aria-hidden>
          {l.kind === 'add' ? '+' : l.kind === 'remove' ? '−' : ' '}
        </span>
        <span className="sr-only">{l.kind === 'add' ? t('edit.added') : l.kind === 'remove' ? t('edit.removed') : ''}</span>
        {l.text}
      </div>,
    )
  })
  if (hidden) {
    out.push(
      <div key="hend" className="px-3 text-subtle select-none">
        {t('edit.sameLines', { count: hidden })}
      </div>,
    )
  }
  return (
    <div className="max-h-[50vh] overflow-auto rounded-lg border bg-surface py-2 font-mono text-xs leading-relaxed" aria-label={t('edit.diff')}>
      {out}
    </div>
  )
}
