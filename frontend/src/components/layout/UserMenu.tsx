import { LogOut, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useLogout, useSession } from '@/lib/queries'

export function UserMenu() {
  const { t } = useTranslation()
  const { data } = useSession()
  const logoutMutation = useLogout()

  const name = data?.user?.username ?? t('auth.unknownUser')
  const groups = data?.user?.groups?.join(', ')

  return (
    <div className="flex items-center gap-1">
      <span
        className="flex max-w-48 items-center gap-1.5 truncate px-1 text-xs text-muted"
        title={groups ? `${name}\n${t('auth.groups')}: ${groups}` : (data?.userError ?? name)}
      >
        <UserRound className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{name}</span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => logoutMutation.mutate()}
        disabled={logoutMutation.isPending}
        aria-label={t('auth.logout')}
        title={t('auth.logout')}
      >
        <LogOut />
      </Button>
    </div>
  )
}
