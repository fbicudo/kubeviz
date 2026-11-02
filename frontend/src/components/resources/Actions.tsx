import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Ban, CirclePause, CirclePlay, History, Layers, RotateCw, Trash2, Unlock } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionDialog } from '@/components/ui/action-dialog'
import { Button } from '@/components/ui/button'
import {
  cordonBody,
  deleteObject,
  deploymentRevisions,
  patchObject,
  pauseBody,
  restartBody,
  rollbackPatch,
  scaleBody,
  useCan,
  type AccessCheck,
} from '@/lib/k8s/actions'
import { collectionPath, kinds, listHref, type ResourceKind } from '@/lib/k8s/catalog'
import { useK8sList } from '@/lib/k8s/queries'
import type { K8sObject } from '@/lib/k8s/types'
import { age } from '@/lib/format'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

type Action = 'scale' | 'restart' | 'pause' | 'rollback' | 'cordon' | 'delete'

const SCALABLE = new Set(['Deployment', 'StatefulSet', 'ReplicaSet'])
const RESTARTABLE = new Set(['Deployment', 'StatefulSet', 'DaemonSet'])

interface ActionBarProps {
  obj: K8sObject
  kind: ResourceKind
  /** Caminho do objeto na API. */
  path: string
  onDone: (message: string) => void
}

/** Ações do objeto; cada botão só aparece se o RBAC do usuário permitir. */
export function ActionBar({ obj, kind, path, onDone }: ActionBarProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState<Action | null>(null)
  const ns = obj.metadata.namespace
  const name = obj.metadata.name
  const base = { group: kind.group, resource: kind.resource, namespace: ns, name }

  const checks: Partial<Record<Action, AccessCheck>> = { delete: { verb: 'delete', ...base } }
  if (SCALABLE.has(kind.kind)) checks.scale = { verb: 'patch', subresource: 'scale', ...base }
  if (RESTARTABLE.has(kind.kind)) checks.restart = { verb: 'patch', ...base }
  if (kind.kind === 'Deployment') {
    checks.pause = { verb: 'patch', ...base }
    checks.rollback = { verb: 'patch', ...base }
  }
  if (kind.kind === 'Node') checks.cordon = { verb: 'patch', ...base }
  const can = useCan(checks as Record<Action, AccessCheck>)

  const spec = (obj.spec ?? {}) as { replicas?: number; paused?: boolean; unschedulable?: boolean }
  const refresh = () => void qc.invalidateQueries({ queryKey: ['k8s'] })
  const done = (msg: string) => {
    refresh()
    onDone(msg)
  }

  const buttons: { action: Action; icon: React.ReactNode; label: string; danger?: boolean }[] = []
  if (can.scale) buttons.push({ action: 'scale', icon: <Layers />, label: t('actions.scale') })
  if (can.restart) buttons.push({ action: 'restart', icon: <RotateCw />, label: t('actions.restart') })
  if (can.pause) buttons.push({ action: 'pause', icon: spec.paused ? <CirclePlay /> : <CirclePause />, label: spec.paused ? t('actions.resume') : t('actions.pause') })
  if (can.rollback) buttons.push({ action: 'rollback', icon: <History />, label: t('actions.rollback') })
  if (can.cordon) buttons.push({ action: 'cordon', icon: spec.unschedulable ? <Unlock /> : <Ban />, label: spec.unschedulable ? t('actions.uncordon') : t('actions.cordon') })
  if (can.delete) buttons.push({ action: 'delete', icon: <Trash2 />, label: t('actions.delete'), danger: true })
  if (buttons.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label={t('actions.toolbar')}>
      {buttons.map((b) => (
        <Button key={b.action} size="sm" onClick={() => setOpen(b.action)} className={cn(b.danger && 'text-critical')}>
          {b.icon}
          {b.label}
        </Button>
      ))}

      {open === 'scale' && (
        <ScaleDialog
          current={spec.replicas ?? 0}
          onClose={() => setOpen(null)}
          onConfirm={async (n) => {
            await patchObject(`${path}/scale`, scaleBody(n), 'merge')
            done(t('actions.scaled', { count: n }))
          }}
        />
      )}
      {open === 'restart' && (
        <ActionDialog
          open
          onOpenChange={() => setOpen(null)}
          title={t('actions.restartTitle', { name })}
          description={t('actions.restartHint')}
          confirmLabel={t('actions.restart')}
          onConfirm={async () => {
            await patchObject(path, restartBody(), 'strategic')
            done(t('actions.restarted'))
          }}
        />
      )}
      {open === 'pause' && (
        <ActionDialog
          open
          onOpenChange={() => setOpen(null)}
          title={spec.paused ? t('actions.resumeTitle', { name }) : t('actions.pauseTitle', { name })}
          description={spec.paused ? t('actions.resumeHint') : t('actions.pauseHint')}
          confirmLabel={spec.paused ? t('actions.resume') : t('actions.pause')}
          onConfirm={async () => {
            await patchObject(path, pauseBody(!spec.paused), 'merge')
            done(spec.paused ? t('actions.resumed') : t('actions.paused'))
          }}
        />
      )}
      {open === 'rollback' && (
        <RollbackDialog
          deployment={obj}
          onClose={() => setOpen(null)}
          onConfirm={async (rs, revision) => {
            await patchObject(path, rollbackPatch(rs), 'json')
            done(t('actions.rolledBack', { revision }))
          }}
        />
      )}
      {open === 'cordon' && (
        <ActionDialog
          open
          onOpenChange={() => setOpen(null)}
          title={spec.unschedulable ? t('actions.uncordonTitle', { name }) : t('actions.cordonTitle', { name })}
          description={spec.unschedulable ? t('actions.uncordonHint') : t('actions.cordonHint')}
          confirmLabel={spec.unschedulable ? t('actions.uncordon') : t('actions.cordon')}
          onConfirm={async () => {
            await patchObject(path, cordonBody(!spec.unschedulable), 'merge')
            done(spec.unschedulable ? t('actions.uncordoned') : t('actions.cordoned'))
          }}
        />
      )}
      {open === 'delete' && (
        <DeleteDialog
          name={name}
          kindName={kind.kind}
          onClose={() => setOpen(null)}
          onConfirm={async () => {
            await deleteObject(path)
            refresh()
            void navigate({ to: listHref(kind) as never, search: (kind.namespaced && ns ? { ns } : {}) as never })
          }}
        />
      )}
    </div>
  )
}

function ScaleDialog({ current, onClose, onConfirm }: { current: number; onClose: () => void; onConfirm: (n: number) => Promise<void> }) {
  const { t } = useTranslation()
  const id = useId()
  const [value, setValue] = useState(String(current))
  const n = Number(value)
  const valid = value.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 1000
  return (
    <ActionDialog
      open
      onOpenChange={onClose}
      title={t('actions.scaleTitle')}
      description={t('actions.scaleHint', { count: current })}
      confirmLabel={valid ? t('actions.scaleTo', { count: n }) : t('actions.scale')}
      disabled={!valid || n === current}
      onConfirm={() => onConfirm(n)}
    >
      <label htmlFor={id} className="block font-medium">
        {t('actions.replicas')}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        max={1000}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-9 w-32 rounded-md border bg-background px-2 font-mono focus:border-accent focus:outline-none"
      />
      {n === 0 && valid && <p className="text-xs text-warn">{t('actions.scaleZero')}</p>}
    </ActionDialog>
  )
}

function RollbackDialog({
  deployment,
  onClose,
  onConfirm,
}: {
  deployment: K8sObject
  onClose: () => void
  onConfirm: (rs: K8sObject, revision: number) => Promise<void>
}) {
  const { t } = useTranslation()
  const ns = deployment.metadata.namespace ?? ''
  const list = useK8sList<K8sObject>(['k8s', 'replicasets-of', deployment.metadata.uid], collectionPath(kinds.replicasets, ns))
  const revisions = deploymentRevisions(deployment, list.data?.items ?? [])
  const [chosen, setChosen] = useState<number | null>(null)
  const target = revisions.find((r) => r.revision === chosen)
  const now = useNow()

  return (
    <ActionDialog
      open
      onOpenChange={onClose}
      title={t('actions.rollbackTitle', { name: deployment.metadata.name })}
      description={t('actions.rollbackHint')}
      confirmLabel={target ? t('actions.rollbackTo', { revision: target.revision }) : t('actions.rollback')}
      disabled={!target || target.current}
      onConfirm={() => onConfirm(target!.replicaSet, target!.revision)}
    >
      {list.isPending ? (
        <p className="text-muted">{t('resources.loading')}</p>
      ) : revisions.length < 2 ? (
        <p className="text-muted">{t('actions.noRevisions')}</p>
      ) : (
        <fieldset className="max-h-72 space-y-1 overflow-auto">
          <legend className="sr-only">{t('actions.revisions')}</legend>
          {revisions.map((r) => (
            <label
              key={r.revision}
              className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-2', chosen === r.revision && 'border-accent', r.current && 'opacity-70')}
            >
              <input type="radio" name="revision" checked={chosen === r.revision} disabled={r.current} onChange={() => setChosen(r.revision)} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">
                  {t('actions.revision', { revision: r.revision })}
                  {r.current && ` · ${t('actions.current')}`}
                </span>
                <span className="block font-mono text-xs break-all text-muted">{r.images.join(', ')}</span>
              </span>
              <span className="font-mono text-xs text-muted">{age(r.replicaSet.metadata.creationTimestamp, now)}</span>
            </label>
          ))}
        </fieldset>
      )}
    </ActionDialog>
  )
}

function DeleteDialog({ name, kindName, onClose, onConfirm }: { name: string; kindName: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useTranslation()
  const id = useId()
  const [typed, setTyped] = useState('')
  return (
    <ActionDialog
      open
      onOpenChange={onClose}
      title={t('actions.deleteTitle', { kind: kindName, name })}
      description={t('actions.deleteHint')}
      confirmLabel={t('actions.delete')}
      danger
      disabled={typed !== name}
      onConfirm={onConfirm}
    >
      <label htmlFor={id} className="block">
        {t('actions.typeName')} <span className="font-mono font-medium">{name}</span>
      </label>
      <input
        id={id}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        className="h-9 w-full rounded-md border bg-background px-2 font-mono focus:border-critical focus:outline-none"
      />
    </ActionDialog>
  )
}
