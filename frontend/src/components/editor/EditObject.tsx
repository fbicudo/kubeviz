import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ShieldCheck, Upload, X } from 'lucide-react'
import { lazy, Suspense, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ApplyError, applyYaml, cleanForEdit, lineDiff, toYaml, yamlProblems } from '@/lib/k8s/apply'
import type { K8sObject } from '@/lib/k8s/types'
import { DiffView } from './DiffView'

// O editor só é baixado quando alguém edita (fica fora do pacote principal).
const YamlEditor = lazy(() => import('./YamlEditor'))

interface EditObjectProps {
  obj: K8sObject
  /** Caminho do objeto na API (sem /api/k8s). */
  path: string
  onClose: () => void
}

interface Validation {
  text: string
  force: boolean
  result: K8sObject
}

/**
 * Edição em YAML: Validar (dry-run no servidor) mostra o que vai mudar;
 * Aplicar só fica disponível para o texto validado.
 */
export function EditObject({ obj, path, onClose }: EditObjectProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const original = useMemo(() => toYaml(cleanForEdit(obj)), [obj])
  const [text, setText] = useState(original)
  const [validation, setValidation] = useState<Validation | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState(false)

  const syntax = yamlProblems(text)
  const isValidated = validation?.text === text

  const run = async (dryRun: boolean, force: boolean) => {
    setBusy(true)
    setError(null)
    setApplied(false)
    try {
      const result = await applyYaml({ path, yaml: text, dryRun, force }, qc)
      if (dryRun) setValidation({ text, force, result })
      else {
        setApplied(true)
        setValidation(null)
        // O watch atualiza a tela; esta recarga cobre quem está sem watch.
        void qc.invalidateQueries({ queryKey: ['k8s'] })
        onClose()
      }
    } catch (e) {
      setValidation(null)
      setError(e as Error)
    } finally {
      setBusy(false)
    }
  }

  const diff = useMemo(
    () => (validation ? lineDiff(original, toYaml(cleanForEdit(validation.result))) : []),
    [validation, original],
  )
  const noChanges = validation && diff.every((l) => l.kind === 'same')

  return (
    <div className="space-y-3">
      {obj.kind === 'Secret' && (
        <p className="flex items-center gap-2 rounded-md border border-warn/40 bg-warn/5 p-2 text-xs">
          <AlertTriangle className="size-4 shrink-0 text-warn" aria-hidden />
          {t('edit.secretVisible')}
        </p>
      )}
      <Suspense fallback={<p className="h-[60vh] rounded-lg border p-4 text-muted">{t('edit.loadingEditor')}</p>}>
        <YamlEditor value={text} onChange={setText} label={t('edit.editorLabel', { name: obj.metadata.name })} />
      </Suspense>

      {syntax.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-xs text-critical">
          {syntax.map((p, i) => (
            <li key={i}>{p.line ? t('edit.syntaxAt', { line: p.line, message: p.message }) : p.message}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void run(true, false)} disabled={busy || syntax.length > 0}>
          <ShieldCheck />
          {t('edit.validate')}
        </Button>
        <Button
          variant="primary"
          onClick={() => void run(false, validation?.force ?? false)}
          disabled={busy || !isValidated || !!noChanges}
          title={!isValidated ? t('edit.validateFirst') : undefined}
        >
          <Upload />
          {validation?.force ? t('edit.applyForce') : t('edit.apply')}
        </Button>
        {text !== original && (
          <Button variant="ghost" onClick={() => setText(original)} disabled={busy}>
            {t('edit.discard')}
          </Button>
        )}
        <Button variant="ghost" className="ml-auto" onClick={onClose} disabled={busy}>
          <X />
          {t('edit.cancel')}
        </Button>
      </div>

      {applied && (
        <p role="status" className="flex items-center gap-2 text-ok">
          <CheckCircle2 className="size-4" aria-hidden />
          {t('edit.applied')}
        </p>
      )}
      {error && <ApplyErrorView error={error} onForce={() => void run(true, true)} busy={busy} />}
      {validation && !isValidated && <p className="text-xs text-warn">{t('edit.changedSinceValidation')}</p>}
      {validation && isValidated && (
        <div className="space-y-2" role="status">
          <p className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="size-4 text-ok" aria-hidden />
            {noChanges ? t('edit.noChanges') : t('edit.validOk')}
          </p>
          {!noChanges && <DiffView lines={diff} />}
        </div>
      )}
    </div>
  )
}

function ApplyErrorView({ error, onForce, busy }: { error: Error; onForce: () => void; busy: boolean }) {
  const { t } = useTranslation()
  const ae = error instanceof ApplyError ? error : null
  const unknown = ae?.unknownFields ?? []
  const title = ae?.isConflict
    ? t('edit.conflict')
    : ae?.status === 403
      ? t('edit.forbidden')
      : (ae && [400, 422].includes(ae.status)) || unknown.length > 0
        ? t('edit.rejected')
        : t('edit.failed')

  return (
    <div role="alert" className="space-y-2 rounded-lg border border-critical/40 bg-critical/5 p-3">
      <div className="font-medium">{title}</div>
      {unknown.length > 0 && (
        <ul className="space-y-0.5">
          {unknown.map((f) => (
            <li key={f}>{t('edit.unknownField', { field: f })}</li>
          ))}
        </ul>
      )}
      {ae && ae.causes.length > 0 ? (
        <ul className="space-y-0.5 font-mono text-xs break-all">
          {ae.causes.map((c, i) => (
            <li key={i}>
              {c.field && <span className="text-muted">{c.field}: </span>}
              {c.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono text-xs break-all text-muted">{error.message}</p>
      )}
      {ae?.isConflict && (
        <>
          <p className="text-muted">{t('edit.conflictHint')}</p>
          <Button size="sm" onClick={onForce} disabled={busy}>
            {t('edit.validateForce')}
          </Button>
        </>
      )}
    </div>
  )
}
