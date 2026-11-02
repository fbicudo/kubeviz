import { useTranslation } from 'react-i18next'
import type { LiveState } from '@/lib/k8s/watch'
import { cn } from '@/lib/utils'

/** Mostra se a lista está em tempo real (watch) ou em consulta periódica. */
export function LiveIndicator({ state }: { state: LiveState }) {
  const { t } = useTranslation()
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted"
      title={t(`live.${state}Hint`)}
      role="status"
    >
      <span
        className={cn(
          'size-2 rounded-full',
          state === 'live' ? 'animate-pulse bg-ok' : state === 'polling' ? 'bg-warn' : 'bg-subtle',
        )}
        aria-hidden
      />
      {t(`live.${state}`)}
    </span>
  )
}
