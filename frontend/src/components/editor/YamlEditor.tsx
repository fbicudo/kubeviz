import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { parseAllDocuments } from 'yaml'

interface YamlEditorProps {
  value: string
  onChange: (value: string) => void
  /** Nome acessível do campo de edição. */
  label: string
}

// Erros de sintaxe YAML marcados no próprio editor.
const yamlLinter = linter((view) => {
  const out: Diagnostic[] = []
  for (const doc of parseAllDocuments(view.state.doc.toString())) {
    for (const e of doc.errors) {
      const [from, to] = e.pos
      out.push({ from, to: Math.max(to, from + 1), severity: 'error', message: e.message.split('\n')[0] })
    }
  }
  return out
})

// Cores vindas dos tokens do tema (escuro e claro).
const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--foreground)', fontSize: '12px', height: '100%' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--subtle)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' },
  '&.cm-focused': { outline: '2px solid var(--ring)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
})

// Realce com os tokens do tema (contraste verificado em theme-contrast.test.ts).
const highlight = HighlightStyle.define([
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--info)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--foreground)' },
  { tag: [tags.number, tags.bool, tags.null, tags.keyword], color: 'var(--warn)' },
  { tag: [tags.comment, tags.meta], color: 'var(--subtle)', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace], color: 'var(--muted)' },
  { tag: tags.invalid, color: 'var(--critical)' },
])

/** Editor de YAML (CodeMirror 6) com realce, busca e erros de sintaxe. */
export default function YamlEditor({ value, onChange, label }: YamlEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          yaml(),
          syntaxHighlighting(highlight),
          yamlLinter,
          lintGutter(),
          theme,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = v
    return () => v.destroy()
    // O documento inicial só é usado na criação; depois o editor é a fonte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label])

  // Substituição externa do conteúdo (ex.: "Descartar alterações").
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
    }
  }, [value])

  return <div ref={host} className="h-[60vh] overflow-hidden rounded-lg border" />
}
