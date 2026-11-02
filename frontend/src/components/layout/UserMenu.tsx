import { Link, useNavigate } from '@tanstack/react-router'
import { LogOut, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useLogout, useSession } from '@/lib/queries'

export function UserMenu() {
  const { t } = useTranslation()
  const { data } = useSession()
  const logoutMutation = useLogout()
  const navigate = useNavigate()

  const name = data?.localUser ?? data?.user?.username ?? t('auth.unknownUser')
  const groups = data?.user?.groups?.join(', ')
  // Com conta local, o nome exibido é a conta; a identidade no cluster vai na dica.
  const kubeIdentity = data?.localUser && data.user ? `${t('auth.kubeIdentity')}: ${data.user.username}\n` : ''

  return (
    <div className="flex items-center gap-1">
      {data?.localUser ? (
        <Link
          to="/account"
          className="flex max-w-48 items-center gap-1.5 truncate rounded px-1 text-xs text-muted hover:text-foreground"
          title={`${t('account.title')}\n${kubeIdentity}`.trim()}
        >
          <UserRound className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
        </Link>
      ) : (
        <span
          className="flex max-w-48 items-center gap-1.5 truncate px-1 text-xs text-muted"
          title={groups ? `${name}\n${kubeIdentity}${t('auth.groups')}: ${groups}` : (data?.userError ?? name)}
        >
          <UserRound className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => {
          // Quem entrar depois pode ser outra pessoa: volta para a página inicial.
          void navigate({ to: '/' })
          logoutMutation.mutate()
        }}
        disabled={logoutMutation.isPending}
        aria-label={t('auth.logout')}
        title={t('auth.logout')}
      >
        <LogOut />
      </Button>
    </div>
  )
}
