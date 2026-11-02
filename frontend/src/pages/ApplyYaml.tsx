import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, FileUp, ShieldCheck, Upload } from 'lucide-react'
import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffView } from '@/components/editor/DiffView'
import { NamespacePicker } from '@/components/resources/common'
import { ObjectLink } from '@/components/resources/ObjectLink'
import { Button } from '@/components/ui/button'
import type { Status } from '@/components/ui/stat-tile'
import { StatusBadge } from '@/components/ui/status-badge'
import { ApiError, apiGet } from '@/lib/api'
import { ApplyError, applyYaml, cleanForEdit, lineDiff, toYaml, type DiffLine } from '@/lib/k8s/apply'
import { useDiscovery } from '@/lib/k8s/discovery'
import { prepareDocuments, type DocProblem, type PreparedDoc } from '@/lib/k8s/documents'
import type { K8sObject } from '@/lib/k8s/types'

const YamlEditor = lazy(() => import('@/components/editor/YamlEditor'))

type DocState = 'new' | 'changed' | 'unchanged' | 'waitingNamespace' | 'error' | 'applied'

interface DocResult {
  doc: PreparedDoc
  state: DocState
  diff?: DiffLine[]
  error?: Error
}

const severity: Record<DocState, Status> = {
  new: 'ok',
  changed: 'warn',
  unchanged: 'unknown',
  waitingNamespace: 'warn',
  error: 'critical',
  applied: 'ok',
}

/** Namespace que um 404 do dry-run diz não existir, se for o caso. */
function missingNamespace(e: unknown): string | undefined {
  if (!(e instanceof ApplyError) || e.status !== 404) return undefined
  return /namespaces "([^"]+)" not found/.exec(e.message)?.[1]
}

/** Aplicar YAML novo (um ou vários documentos), validando antes no cluster. */
export function ApplyYaml() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const discovery = useDiscovery()
  const [text, setText] = useState('')
  const [namespace, setNamespace] = useState('default')
  const [results, setResults] = useState<DocResult[] | null>(null)
  const [problems, setProblems] = useState<DocProblem[]>([])
  const [validatedFor, setValidatedFor] = useState<string | null>(null)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const signature = `${namespace}\n${text}`
  const isValidated = validatedFor === signature

  const validate = async (withForce: boolean) => {
    if (!discovery.data) return
    setBusy(true)
    setApplied(false)
    setForce(withForce)
    // Não mostrar o resultado anterior como se fosse desta validação.
    setResults(null)
    setProblems([])
    const batch = prepareDocuments(text, discovery.data, namespace, t)
    setProblems(batch.problems)
    const namespacesInBatch = new Set(batch.docs.filter((d) => d.obj.kind === 'Namespace').map((d) => d.obj.metadata.name))
    const out: DocResult[] = []
    for (const doc of batch.docs) {
      try {
        let current: K8sObject | null = null
        try {
          current = await apiGet<K8sObject>(`/api/k8s${doc.path}`)
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e
        }
        const result = await applyYaml({ path: doc.path, yaml: toYaml(doc.obj), dryRun: true, force: withForce }, qc)
        if (!current) out.push({ doc, state: 'new' })
        else {
          const diff = lineDiff(
            toYaml(cleanForEdit({ ...current, apiVersion: doc.obj.apiVersion, kind: doc.obj.kind })),
            toYaml(cleanForEdit({ ...result, apiVersion: doc.obj.apiVersion, kind: doc.obj.kind })),
          )
          out.push({ doc, state: diff.some((l) => l.kind !== 'same') ? 'changed' : 'unchanged', diff })
        }
      } catch (e) {
        const ns = missingNamespace(e)
        out.push({ doc, state: ns && namespacesInBatch.has(ns) ? 'waitingNamespace' : 'error', error: e as Error })
      }
    }
    setResults(out)
    setValidatedFor(batch.problems.length === 0 ? signature : null)
    setBusy(false)
  }

  const apply = async () => {
    if (!results) return
    setBusy(true)
    const out = [...results]
    for (let i = 0; i < out.length; i++) {
      const r = out[i]
      if (r.state === 'unchanged') continue
      try {
        await applyYaml({ path: r.doc.path, yaml: toYaml(r.doc.obj), dryRun: false, force }, qc)
        out[i] = { doc: r.doc, state: 'applied' }
      } catch (e) {
        out[i] = { doc: r.doc, state: 'error', error: e as Error }
      }
      setResults([...out])
    }
    setValidatedFor(null)
    setApplied(true)
    setBusy(false)
    void qc.invalidateQueries({ queryKey: ['k8s'] })
  }

  const counts = useMemo(() => {
    const c: Partial<Record<DocState, number>> = {}
    for (const r of results ?? []) c[r.state] = (c[r.state] ?? 0) + 1
    return c
  }, [results])
  const hasErrors = (counts.error ?? 0) > 0
  const hasConflicts = results?.some((r) => r.error instanceof ApplyError && r.error.isConflict) ?? false
  const nothingToDo = results !== null && results.every((r) => r.state === 'unchanged')

  const importFile = async (file: File | undefined) => {
    if (file) setText(await file.text())
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">{t('nav.apply')}</h1>
        <p className="text-muted">{t('applyYaml.subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <NamespacePicker value={namespace} onChange={(ns) => setNamespace(ns || 'default')} />
        <span className="text-xs text-muted">{t('applyYaml.namespaceHint')}</span>
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,.json"
          className="hidden"
          onChange={(e) => void importFile(e.target.files?.[0])}
          aria-label={t('applyYaml.importFile')}
        />
        <Button size="sm" className="ml-auto" onClick={() => fileInput.current?.click()}>
          <FileUp />
          {t('applyYaml.importFile')}
        </Button>
      </div>

      <Suspense fallback={<p className="h-[60vh] rounded-lg border p-4 text-muted">{t('edit.loadingEditor')}</p>}>
        <YamlEditor value={text} onChange={setText} label={t('applyYaml.editorLabel')} />
      </Suspense>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void validate(false)} disabled={busy || !text.trim() || !discovery.data}>
          <ShieldCheck />
          {t('edit.validate')}
        </Button>
        <Button
          variant="primary"
          onClick={() => void apply()}
          disabled={busy || !isValidated || hasErrors || nothingToDo}
          title={!isValidated ? t('edit.validateFirst') : undefined}
        >
          <Upload />
          {force ? t('edit.applyForce') : t('applyYaml.applyAll')}
        </Button>
        {discovery.isError && <span className="text-critical">{discovery.error.message}</span>}
      </div>

      {results && validatedFor !== null && !isValidated && !applied && (
        <p className="text-xs text-warn">{t('edit.changedSinceValidation')}</p>
      )}

      {busy && !results && (
        <p role="status" className="text-muted">
          {t('applyYaml.validating')}
        </p>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-lg border border-critical/40 bg-critical/5 p-3">
          {problems.map((p, i) => (
            <li key={i}>{t('applyYaml.docProblem', { index: p.index, message: p.message })}</li>
          ))}
        </ul>
      )}

      {results && (
        <section className="space-y-2" aria-label={t('applyYaml.results')}>
          <p className="flex items-center gap-2 font-medium" role="status">
            {applied && !hasErrors && <CheckCircle2 className="size-4 text-ok" aria-hidden />}
            {applied
              ? hasErrors
                ? t('applyYaml.appliedWithErrors')
                : t('applyYaml.appliedAll', { count: counts.applied ?? 0 })
              : nothingToDo
                ? t('edit.noChanges')
                : t('applyYaml.summary', {
                    total: results.length,
                    new: counts.new ?? 0,
                    changed: counts.changed ?? 0,
                    unchanged: counts.unchanged ?? 0,
                  }) +
                  (counts.waitingNamespace ? ` ${t('applyYaml.summaryWaiting', { count: counts.waitingNamespace })}` : '') +
                  (counts.error ? ` ${t('applyYaml.summaryErrors', { count: counts.error })}` : '')}
          </p>
          {hasConflicts && !applied && (
            <div className="space-y-1 rounded-lg border border-warn/40 bg-warn/5 p-3">
              <p>{t('edit.conflictHint')}</p>
              <Button size="sm" onClick={() => void validate(true)} disabled={busy}>
                {t('edit.validateForce')}
              </Button>
            </div>
          )}
          <ul className="space-y-2">
            {results.map((r) => (
              <DocResultItem key={`${r.doc.index}-${r.doc.path}`} result={r} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function DocResultItem({ result: r }: { result: DocResult }) {
  const { t } = useTranslation()
  const m = r.doc.obj.metadata
  const [open, setOpen] = useState(r.state === 'changed')
  const unknown = r.error instanceof ApplyError ? r.error.unknownFields : []

  return (
    <li className="rounded-lg border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge severity={severity[r.state]}>{t(`applyYaml.state.${r.state}`)}</StatusBadge>
        <span className="text-muted">{r.doc.obj.kind}</span>
        {r.state === 'applied' ? (
          <ObjectLink kind={r.doc.kind} name={m.name} namespace={m.namespace} />
        ) : (
          <span className="font-medium">{m.name}</span>
        )}
        {m.namespace && <span className="text-muted">· {m.namespace}</span>}
        <span className="ml-auto text-xs text-subtle">{t('applyYaml.docNumber', { index: r.doc.index })}</span>
      </div>
      {r.doc.notes.map((n) => (
        <p key={n} className="mt-1 text-xs text-muted">
          {n}
        </p>
      ))}
      {r.state === 'waitingNamespace' && <p className="mt-1 text-xs text-muted">{t('applyYaml.waitingHint')}</p>}
      {r.error && r.state === 'error' && (
        <div className="mt-1 text-xs">
          {unknown.map((f) => (
            <p key={f}>{t('edit.unknownField', { field: f })}</p>
          ))}
          <p className="font-mono break-all text-critical">{r.error.message}</p>
        </div>
      )}
      {r.diff && r.state === 'changed' && (
        <div className="mt-2">
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? t('applyYaml.hideDiff') : t('applyYaml.showDiff')}
          </button>
          {open && (
            <div className="mt-1">
              <DiffView lines={r.diff} />
            </div>
          )}
        </div>
      )}
    </li>
  )
}
