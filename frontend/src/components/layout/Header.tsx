import { Languages, Moon, PanelLeft, Search, Sun } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { languages } from '@/i18n'
import { useTheme } from '@/lib/theme-context'
import { useCtrlK } from '@/lib/use-shortcut'
import { ClusterSelector } from './ClusterSelector'
import { CommandPalette } from './CommandPalette'
import { UserMenu } from './UserMenu'

export function Header({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { t, i18n } = useTranslation()
  const { theme, toggle } = useTheme()
  const [searching, setSearching] = useState(false)
  useCtrlK(useCallback(() => setSearching(true), []))

  const nextLang = () => {
    const i = languages.findIndex((l) => l.code === i18n.resolvedLanguage)
    void i18n.changeLanguage(languages[(i + 1) % languages.length].code)
  }

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-surface px-2">
      <Button variant="ghost" size="icon" onClick={onToggleSidebar} aria-label={t('header.toggleSidebar')}>
        <PanelLeft />
      </Button>

      <ClusterSelector />

      <button
        type="button"
        onClick={() => setSearching(true)}
        aria-keyshortcuts="Control+K"
        className="ml-auto flex h-8 w-72 items-center gap-2 rounded-md border bg-background px-2 text-muted hover:text-foreground"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1 text-left">{t('header.search')}</span>
        <kbd className="rounded border px-1 font-mono text-[11px] text-subtle">Ctrl K</kbd>
      </button>

      <Button variant="ghost" size="sm" onClick={nextLang} aria-label={t('header.language')}>
        <Languages />
        {i18n.resolvedLanguage === 'en' ? 'EN' : 'PT'}
      </Button>
      <Button variant="ghost" size="icon" onClick={toggle} aria-label={t('header.theme')}>
        {theme === 'dark' ? <Sun /> : <Moon />}
      </Button>
      <div className="mx-1 h-5 w-px bg-border" aria-hidden />
      <UserMenu />
      <CommandPalette open={searching} onOpenChange={setSearching} />
    </header>
  )
}
