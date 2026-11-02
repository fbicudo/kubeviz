// Mede o desempenho do KubeViz com muitos objetos (tarefa 1.10, RNF-04/05).
// Pré-requisitos: cenário de carga (hack/scale/kwok.sh up 5000) e uma
// instância local do KubeViz em modo link.
//
// Variáveis: KUBEVIZ_LOCAL_URL, KUBEVIZ_LOCAL_TOKEN, KUBE_CONTEXT
// (padrão kind-kubeviz-dev). Uso: pnpm perf

import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

const base = process.env.KUBEVIZ_LOCAL_URL ?? 'http://127.0.0.1:4466'
const token = process.env.KUBEVIZ_LOCAL_TOKEN
const context = process.env.KUBE_CONTEXT ?? 'kind-kubeviz-dev'
if (!token) throw new Error('defina KUBEVIZ_LOCAL_TOKEN')
const kubectl = (...args) => execFileSync('kubectl', ['--context', context, ...args], { encoding: 'utf8' })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' })
// Coleta tarefas longas (> 50 ms) da thread principal: são os travamentos.
await ctx.addInitScript(() => {
  window.__long = []
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask', buffered: true })
})
const page = await ctx.newPage()
const results = []
const ms = (t0) => Math.round(performance.now() - t0)
const longTasks = async () => {
  const l = await page.evaluate(() => window.__long.splice(0))
  return { max: Math.round(Math.max(0, ...l)), total: Math.round(l.reduce((a, b) => a + b, 0)) }
}
const record = async (name, time, extra = {}) => {
  const lt = await longTasks()
  const r = { cenário: name, 'tempo (ms)': time, 'maior travamento (ms)': lt.max, 'travamento total (ms)': lt.total, ...extra }
  results.push(r)
  console.log(JSON.stringify(r))
}
const waitCount = async (n) => {
  try {
    await page.getByText(new RegExp(`^${n} de ${n} pods$`)).waitFor({ timeout: 600_000 })
  } catch (e) {
    console.log('esperava', n, 'a tela mostra', await page.getByText(/^\d+ de \d+ pods?$/).textContent({ timeout: 30_000 }).catch(() => '(sem resposta)'))
    console.table(results)
    throw e
  }
}

await page.goto(`${base}/auth/local?token=${token}`)
await page.getByRole('heading', { name: 'Visão geral' }).waitFor()
await longTasks()

// 1. Primeira carga (RNF-04: < 2 s): abrir /pods direto no navegador.
const total = Number(kubectl('get', 'pods', '-A', '--no-headers').trim().split('\n').length)
let t0 = performance.now()
await page.goto(`${base}/pods`)
await page.getByRole('cell').first().waitFor({ timeout: 120_000 })
const firstRow = ms(t0)
await waitCount(total)
await record(`primeira carga: ${total} pods`, ms(t0), { 'primeira linha (ms)': firstRow })

// Navegação com a lista já em cache (RNF-04: < 300 ms): Visão geral → Pods.
await page.getByRole('link', { name: 'Visão geral' }).click()
await page.getByRole('region', { name: 'Pods' }).getByText(new RegExp(`/${total}$`)).waitFor({ timeout: 120_000 })
await page.waitForTimeout(1000)
await longTasks()
t0 = performance.now()
await page.getByRole('link', { name: 'Pods', exact: true }).click()
await waitCount(total)
await record('navegar para Pods (com cache)', ms(t0))

// 2. Filtrar (RNF-05: < 1 s).
t0 = performance.now()
await page.getByRole('textbox', { name: /Filtrar/ }).fill('app-3-')
await page.getByText(/^\d+ de \d+ pods$/).filter({ hasNotText: new RegExp(`^${total} de`) }).waitFor()
await record('filtrar a lista', ms(t0), { resultado: await page.getByText(/^\d+ de \d+ pods$/).textContent() })
t0 = performance.now()
await page.getByRole('textbox', { name: /Filtrar/ }).fill('')
await waitCount(total)
await record('limpar o filtro', ms(t0))

// 3. Rolar a lista até o fim.
t0 = performance.now()
for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 4000)
await page.waitForTimeout(500)
await record('rolar 20 vezes', ms(t0) - 500)

// 4. Rajada de eventos do watch: 500 pods excluídos e recriados.
await page.waitForTimeout(1000)
await longTasks()
t0 = performance.now()
kubectl('-n', 'carga', 'scale', 'deployment/app-1', '--replicas=0')
await waitCount(total - 500)
await record('watch: 500 pods excluídos', ms(t0))
t0 = performance.now()
kubectl('-n', 'carga', 'scale', 'deployment/app-1', '--replicas=500')
await waitCount(total)
await record('watch: 500 pods criados', ms(t0))
// Pods criados passam por vários estados: espera o watch assentar.
await page.waitForTimeout(5000)
await record('watch: assentar (5 s)', 5000)

// 5. Busca global por nome.
t0 = performance.now()
await page.keyboard.press('Control+k')
await page.keyboard.type('app-7-')
await page.getByRole('option', { name: /^app-7-/ }).first().waitFor({ timeout: 60_000 })
await record('busca global (Ctrl+K)', ms(t0))
await page.keyboard.press('Escape')

// 6. Página de eventos.
t0 = performance.now()
await page.getByRole('link', { name: 'Eventos', exact: true }).click()
await page.getByRole('radio', { name: /^Todos \([1-9]/ }).waitFor({ timeout: 120_000 })
await record('página de eventos', ms(t0), { resultado: await page.getByRole('radio', { name: /^Todos/ }).textContent() })

const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize)
const domNodes = await page.evaluate(() => document.getElementsByTagName('*').length)
await page.getByRole('link', { name: 'Pods', exact: true }).click()
await waitCount(total)
const podDom = await page.evaluate(() => document.getElementsByTagName('*').length)
console.table(results)
console.log(`memória JS do navegador: ${Math.round(heap / 1048576)} MB; elementos no DOM: eventos ${domNodes}, pods ${podDom}`)
await browser.close()
