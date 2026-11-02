import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './button'

interface ActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  confirmLabel: string
  /** Ação destrutiva: botão em vermelho. */
  danger?: boolean
  disabled?: boolean
  onConfirm: () => Promise<void>
}

/** Diálogo de confirmação com estado de espera e erro (Radix: foco e Esc acessíveis). */
export function ActionDialog({ open, onOpenChange, title, description, children, confirmLabel, danger, disabled, onConfirm }: ActionDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!busy) {
          setError(null)
          onOpenChange(o)
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-lg border bg-surface p-5 text-[13px] shadow-xl">
          <div className="flex items-start gap-3">
            <Dialog.Title className="flex-1 text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t('edit.cancel')} disabled={busy}>
                <X />
              </Button>
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className="text-muted">{description}</Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{title}</Dialog.Description>
          )}
          {children}
          {error && (
            <p role="alert" className="rounded-md border border-critical/40 bg-critical/5 p-2 font-mono text-xs break-all text-critical">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Dialog.Close asChild>
              <Button disabled={busy}>{t('edit.cancel')}</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              className={danger ? 'bg-critical text-background hover:bg-critical/90' : undefined}
              onClick={() => void confirm()}
              disabled={busy || disabled}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
