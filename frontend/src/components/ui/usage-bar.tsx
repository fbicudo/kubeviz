import { cn } from '@/lib/utils'

interface UsageBarProps {
  /** Rótulo acessível (ex.: "CPU de kind-control-plane"). */
  label: string
  used: number
  /** Capacidade (alocável) ou, sem ela, o maior valor da tabela. */
  max: number
  /** Reservado (requests): marcador sobre a barra. */
  reserved?: number
  /** Texto exibido ao lado (ex.: "152m / 4"). */
  text: string
  /** Mostrar a porcentagem do uso sobre max. */
  percent?: boolean
}

/** Barra de uso com marcador de reservas; cor conforme a ocupação. */
export function UsageBar({ label, used, max, reserved, text, percent = true }: UsageBarProps) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0
  const reservedPct = max > 0 && reserved ? Math.min(100, (reserved / max) * 100) : undefined
  // Sem porcentagem, a barra é só comparativa (relativa ao maior da lista): cor neutra.
  const color = !percent ? 'bg-accent' : pct >= 90 ? 'bg-critical' : pct >= 75 ? 'bg-warn' : 'bg-accent'
  return (
    <div className="flex min-w-40 items-center gap-2">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={percent ? `${text} (${Math.round(pct)}%)` : text}
        className="relative h-2 w-24 shrink-0 overflow-hidden rounded-full bg-surface-raised"
      >
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
        {reservedPct !== undefined && <div className="absolute top-0 h-full w-0.5 bg-foreground/70" style={{ left: `calc(${reservedPct}% - 1px)` }} />}
      </div>
      <span className="font-mono text-xs whitespace-nowrap">
        {text}
        {percent && max > 0 && <span className="ml-1 text-muted">{Math.round(pct)}%</span>}
      </span>
    </div>
  )
}
