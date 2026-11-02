import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { ResourceKind } from '@/lib/k8s/catalog'
import { cn } from '@/lib/utils'

interface ObjectLinkProps {
  kind: Pick<ResourceKind, 'group' | 'version' | 'resource'>
  name: string
  namespace?: string
  className?: string
  children?: ReactNode
}

/** Link (navegação interna, sem recarregar) para o detalhe de um objeto. */
export function ObjectLink({ kind, name, namespace, className, children }: ObjectLinkProps) {
  return (
    <Link
      to="/view/$group/$version/$resource/$name"
      params={{ group: kind.group || 'core', version: kind.version, resource: kind.resource, name }}
      search={(namespace ? { ns: namespace } : {}) as never}
      className={cn('text-accent hover:underline', className)}
    >
      {children ?? name}
    </Link>
  )
}
