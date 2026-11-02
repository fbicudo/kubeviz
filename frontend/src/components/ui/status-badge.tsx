import { cn } from '@/lib/utils'
import type { Status } from './stat-tile'

const styles: Record<Status, string> = {
  ok: 'bg-ok/12 text-ok',
  warn: 'bg-warn/12 text-warn',
  critical: 'bg-critical/12 text-critical',
  unknown: 'bg-surface-raised text-muted',
}

/** Rótulo colorido de status (Running, CrashLoopBackOff…). */
export function StatusBadge({ severity, children }: { severity: Status; children: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium', styles[severity])}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  )
}
