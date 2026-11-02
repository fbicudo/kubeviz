// Gera as capturas de tela da documentação (docs/img) a partir de duas
// instâncias do KubeViz em execução com o cenário de demonstração (make demo):
//
//   modo local      ./bin/kubeviz --kubeconfig ~/.kube/kubeviz-demo.yaml ...
//   modo in-cluster make kind-install + kubectl port-forward
//
// Variáveis de ambiente:
//   KUBEVIZ_LOCAL_URL       ex.: https://127.0.0.1:4466
//   KUBEVIZ_LOCAL_TOKEN     token do link impresso pelo modo local
//   KUBEVIZ_INCLUSTER_URL   ex.: https://127.0.0.1:8443 (opcional)
//   KUBEVIZ_TOKEN_DEV       kubectl create token dev -n demo
//   KUBEVIZ_TOKEN_LEITOR    kubectl create token leitor -n demo
//
// Uso: pnpm screenshots   (navegador: pnpm exec playwright install chromium)

import { chromium } from 'playwright'

const env = (name, required = true) => {
  const v = process.env[name]
  if (!v && required) throw new Error(`defina ${name}`)
  return v
}
const out = new URL('../../docs/img/', import.meta.url).pathname
const localURL = env('KUBEVIZ_LOCAL_URL')
const inClusterURL = env('KUBEVIZ_INCLUSTER_URL', false)

const browser = await chromium.launch()
const errors = []

async function newPage() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 760 },
    locale: 'pt-BR',
    ignoreHTTPSErrors: true, // certificados autoassinados da demonstração
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  return page
}

async function shot(page, name) {
  await page.waitForTimeout(400) // animações e atualização dos indicadores
  await page.screenshot({ path: `${out}${name}.png` })
  console.log(`  ${name}.png`)
}

async function pick(page, combobox, option) {
  await page.getByRole('combobox', { name: combobox }).click()
  // A opção pode trazer o namespace padrão ao lado do nome ("dev-limitado demo").
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await page.getByRole('option', { name: new RegExp(`^${escaped}(\\s|$)`) }).click()
}

// --- Modo local -------------------------------------------------------------
console.log('modo local:')
{
  const page = await newPage()
  await page.goto(localURL)
  await page.getByText('link exibido no terminal').waitFor()
  await shot(page, 'login-local')

  await page.goto(`${localURL}/auth/local?token=${env('KUBEVIZ_LOCAL_TOKEN')}`)
  await page.getByText(/pods? com falha/).waitFor()
  await shot(page, 'visao-geral')

  await page.getByRole('link', { name: 'Pods', exact: true }).click()
  await page.getByText('imagem-inexistente').waitFor()
  await shot(page, 'pods-admin')

  await page.getByRole('combobox', { name: 'Namespace' }).click()
  await page.keyboard.type('ku')
  await shot(page, 'seletor-namespace')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Alternar tema' }).click()
  await shot(page, 'pods-claro')
  await page.getByRole('button', { name: 'Alternar tema' }).click()

  await page.getByRole('link', { name: 'Deployments', exact: true }).click()
  await page.getByRole('cell', { name: 'coredns' }).waitFor()
  await page.getByRole('button', { name: 'Mais colunas' }).click()
  await shot(page, 'recursos-deployments')

  await page.getByRole('link', { name: 'Controle de acesso' }).click()
  await page.getByRole('tab', { name: 'ClusterRoles' }).click()
  await page.getByRole('cell', { name: 'cluster-admin', exact: true }).waitFor()
  await shot(page, 'recursos-rbac')

  await page.getByRole('link', { name: 'Pods', exact: true }).click()
  await page.getByText('imagem-inexistente').waitFor()

  await pick(page, 'Cluster', 'dev-limitado')
  await page.getByText('Sem permissão para listar pods em todos os namespaces').waitFor()
  await shot(page, 'pods-sem-permissao')

  await page.getByRole('combobox', { name: 'Namespace' }).click()
  await page.keyboard.type('demo')
  await page.keyboard.press('Enter')
  await page.getByText('imagem-inexistente').waitFor()
  await shot(page, 'pods-limitado-demo')

  await pick(page, 'Cluster', 'inacessivel')
  await page.getByRole('link', { name: 'Visão geral' }).click()
  await page.getByText('Cluster inacessível', { exact: true }).first().waitFor()
  await shot(page, 'cluster-inacessivel')

  // Deixa a instância como estava (contexto de administrador).
  await pick(page, 'Cluster', 'kind-kubeviz-dev')
}

// --- Modo in-cluster ----------------------------------------------------------
if (inClusterURL) {
  console.log('modo in-cluster:')
  const login = async (token) => {
    const page = await newPage()
    await page.goto(inClusterURL)
    const field = page.getByLabel('Token de acesso ao Kubernetes')
    await field.waitFor()
    if (!token) return page
    await field.fill(token)
    await page.getByRole('button', { name: 'Entrar' }).click()
    await page.getByRole('heading', { name: 'Visão geral' }).waitFor()
    return page
  }

  await shot(await login(), 'login-token')

  const dev = await login(env('KUBEVIZ_TOKEN_DEV'))
  await dev.goto(`${inClusterURL}/pods?ns=demo`)
  await dev.getByText('imagem-inexistente').waitFor()
  await shot(dev, 'incluster-dev-pods')

  const leitor = await login(env('KUBEVIZ_TOKEN_LEITOR'))
  await leitor.getByText(/pods? com falha/).waitFor()
  await shot(leitor, 'incluster-leitor-overview')
}

await browser.close()
if (errors.length) {
  console.error('erros nas páginas:', errors)
  process.exit(1)
}
