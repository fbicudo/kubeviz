import * as Popover from '@radix-ui/react-popover'
import { Command } from 'cmdk'
import { Check, ChevronsUpDown, CornerDownLeft } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface ComboboxOption {
  value: string
  label: string
  hint?: string
}

interface ComboboxProps {
  /** Nome acessível do controle (ex.: "Namespace"). */
  label: string
  value: string
  options: ComboboxOption[]
  onChange: (value: string) => void
  /** Conteúdo do botão; padrão: rótulo da opção selecionada. */
  children?: ReactNode
  searchPlaceholder?: string
  emptyText?: string
  /** Permite usar o texto digitado mesmo sem opção correspondente. */
  allowCustom?: boolean
  disabled?: boolean
  className?: string
}

/**
 * Seletor com busca (Popover + cmdk). Acessível pelo teclado: abre com
 * Enter/Espaço, filtra digitando, navega com as setas e confirma com Enter.
 */
export function Combobox({
  label,
  value,
  options,
  onChange,
  children,
  searchPlaceholder,
  emptyText,
  allowCustom = false,
  disabled,
  className,
}: ComboboxProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = options.find((o) => o.value === value)
  const custom = search.trim()
  const showCustom = allowCustom && custom !== '' && !options.some((o) => o.value === custom)

  const choose = (v: string) => {
    onChange(v)
    setOpen(false)
    setSearch('')
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        role="combobox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        className={cn(
          'flex h-8 min-w-0 items-center gap-2 rounded-md border bg-surface px-2 text-left hover:bg-surface-raised disabled:opacity-60',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{children ?? selected?.label ?? value}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-72 overflow-hidden rounded-md border bg-surface-raised text-[13px] text-foreground shadow-lg"
        >
          <Command label={label}>
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={searchPlaceholder ?? t('combobox.search')}
              className="h-9 w-full border-b bg-transparent px-3 outline-none placeholder:text-subtle"
            />
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="px-2 py-3 text-center text-muted">
                {emptyText ?? t('combobox.empty')}
              </Command.Empty>
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  onSelect={() => choose(o.value)}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 data-[selected=true]:bg-accent/12 data-[selected=true]:text-foreground"
                >
                  <Check className={cn('size-3.5 shrink-0 text-accent', o.value !== value && 'invisible')} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="shrink-0 text-xs text-muted">{o.hint}</span>}
                </Command.Item>
              ))}
              {showCustom && (
                <Command.Item
                  value={`__custom__ ${custom}`}
                  onSelect={() => choose(custom)}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 data-[selected=true]:bg-accent/12"
                >
                  <CornerDownLeft className="size-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="truncate">{t('combobox.useCustom', { value: custom })}</span>
                </Command.Item>
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
