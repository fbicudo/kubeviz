import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type Status = 'ok' | 'warn' | 'critical' | 'unknown'

const statusDot: Record<Status, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  critical: 'bg-critical',
  unknown: 'bg-subtle',
}

interface StatTileProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  status?: Status
  className?: string
}

/** Indicador numérico compacto (KPI) usado nos painéis. */
export function StatTile({ label, value, hint, status = 'unknown', className }: StatTileProps) {
  return (
    <section className={cn('rounded-lg border bg-surface p-3', className)} aria-label={label}>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className={cn('size-2 rounded-full', statusDot[status])} aria-hidden />
        {label}
      </div>
      <div className="mt-1.5 font-mono text-2xl font-semibold text-foreground">{value}</div>
      {hint && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </section>
  )
}
