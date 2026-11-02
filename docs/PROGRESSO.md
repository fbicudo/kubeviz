# Progresso do Kubora

Ponto de partida de cada sessão de trabalho: o que foi feito, o que vem a seguir
e o que está bloqueado. Atualize ao fim de cada tarefa.

**Fase atual:** 0 — Fundação ([roadmap](05-roadmap.md#fase-0--fundação-45-semanas--v01))

## Concluído

### 02/11/2026 — Tarefa 0.1: esqueleto do repositório
- Repositório git, licença Apache-2.0, `CONTRIBUTING`, `CODE_OF_CONDUCT`
  (Contributor Covenant 2.1), `SECURITY`, `GOVERNANCE`, `MAINTAINERS`, modelos de
  issue e PR, `.editorconfig`, `Makefile`, CI do GitHub Actions.
- **Backend Go** (`backend/`, módulo `kubora.dev/kubora`): configuração por
  flags/ambiente (`KUBORA_*`), servidor HTTP com encerramento gracioso, logs
  estruturados (slog), `/healthz`, `/readyz`, `/api/v1/version`, 404 em JSON para
  rotas de API, cabeçalhos de segurança (CSP etc.), UI embutida com `go:embed` e
  fallback de SPA, `--version`.
- **Frontend** (`frontend/`): Vite + React 19 + TypeScript (strict) + Tailwind v4,
  tokens de cor semânticos com tema escuro padrão e claro, layout (menu lateral
  recolhível, cabeçalho com seletor de cluster e busca como espaços reservados),
  TanStack Router e Query, i18n pt-BR/en com detecção do idioma do navegador,
  página de visão geral com indicadores reservados e status do backend.
- **Verificado:** `go vet` e testes Go (config, servidor, SPA, cabeçalhos,
  shutdown) passam; `tsc -b` e 5 testes Vitest passam (navegação, tema, idioma,
  paridade das traduções); binário único de 9 MB serve a UI e a API.
- **Não verificado:** CI no GitHub (repositório ainda não publicado).

### 02/11/2026 — Ambiente com Docker e verificação visual
- Instalados Docker 29.1, make 4.4 e as bibliotecas do Chromium (Playwright).
- `make lint`, `make test` e `make build` passam; lint do frontend sem avisos
  (hook `useTheme` separado em `lib/theme-context.ts`).
- Interface conferida em Chromium headless: tema escuro e claro, pt-BR e inglês,
  navegação pelo menu, sem erros no console nem bloqueios da CSP. Capturas em
  [img/overview-dark.png](img/overview-dark.png) e [img/pods-light.png](img/pods-light.png).
- Contato do Código de Conduta definido: fbicudo@gmail.com.
- Cluster de desenvolvimento `kind-kubora-dev` (Kubernetes 1.37, 1 nó) criado e
  definido como contexto atual do kubectl.

### 02/11/2026 — Tarefa 0.2: conexão com o cluster
- **Pacote `internal/cluster`** (client-go 0.37): modos `local` (kubeconfig) e
  `in-cluster` (ServiceAccount), com detecção automática (`--mode auto`). Troca
  de contexto em memória, sem alterar o kubeconfig do usuário. Consulta
  `/version` com timeout de 5 s; erros de conexão aparecem no estado, não
  derrubam o servidor.
- **Novas flags:** `--context` e `--mode` (env `KUBORA_CONTEXT`, `KUBORA_MODE`).
- **API:** `GET /api/v1/cluster`, `GET /api/v1/contexts`,
  `PUT /api/v1/contexts/current`.
- **Segurança do modo local** (o servidor usa as credenciais do kubeconfig e
  ainda não tem login):
  - requisições que alteram estado exigem JSON e são recusadas se vierem de
    outro site (`Sec-Fetch-Site`/`Origin`) — proteção contra CSRF;
  - escutando em localhost, o cabeçalho `Host` precisa ser localhost/127.0.0.1/::1
    — proteção contra DNS rebinding;
  - aviso no log se o modo local for exposto fora de localhost.
- **Interface:** seletor de contexto no cabeçalho (indicador verde/vermelho e
  versão) e cartão "Cluster" na visão geral, com modo, servidor e erro.
- **Verificado:**
  - testes Go: 8 do pacote cluster (API server falso via `httptest`), endpoints,
    CSRF e Host; 7 testes Vitest, incluindo troca de contexto;
  - `make test-integration` contra o kind: conectado ao Kubernetes v1.37.0;
  - binário de ponta a ponta com um segundo contexto inválido: troca, estado de
    erro, retorno, recusa de CSRF e de Host falso, kubeconfig intacto;
  - capturas: [img/cluster-conectado.png](img/cluster-conectado.png) e
    [img/cluster-inacessivel.png](img/cluster-inacessivel.png).
- **Mudança de plano:** os testes com `envtest` (API server real em memória)
  ficam para a 0.3, onde serão necessários para testar RBAC. Na 0.2 bastou um
  API server falso, mais leve.
- **Não testado:** modo in-cluster de verdade (depende do Helm chart, tarefa 0.5).

## Próximas tarefas (Fase 0)

1. **0.3 — Autenticação por token e proxy autenticado:** login com token bearer,
   sessão em cookie `HttpOnly`, proxy `/api/k8s/*` com a identidade do usuário
   (impersonation no modo in-cluster); tela de login; testes de RBAC com
   `envtest`.
2. **0.4 — Primeira lista real:** pods do namespace, respeitando o RBAC do
   usuário (critério de pronto da Fase 0). Preenche os indicadores de nós e pods
   da visão geral.
3. **0.5 — Empacotamento:** Dockerfile (distroless, multi-arquitetura) e Helm
   chart com ServiceAccount de permissões mínimas; testar o modo in-cluster no kind.
4. **0.6 — Revisão visual:** ajustar tokens de cor e densidade, definir logo e
   paleta finais; trocar o `<select>` nativo do seletor de contexto por um
   componente com busca.
5. **0.7 — Publicação:** criar o repositório no GitHub, confirmar o CI verde,
   ativar o relato privado de vulnerabilidades.

## Bloqueios e pendências do responsável

| Item | Por quê | Como resolver |
|------|---------|---------------|
| Usuário do GitHub | `MAINTAINERS.md` e caminhos do chart | Definir antes da tarefa 0.7 (publicação); não bloqueia 0.2 a 0.6 |
| Domínio `kubora.dev` | O módulo Go usa `kubora.dev/kubora` | Definir antes da tarefa 0.7; se não for registrado, trocar o caminho do módulo (substituição simples nos imports) |

## Ambiente de desenvolvimento desta máquina

- Em `~/.local` (PATH configurado em `~/.profile`): Go 1.27.3, Node.js 26.13 LTS,
  pnpm 12.16, kubectl 1.37, Helm 4.3, kind 0.33.
- Pelo apt: Docker 29.1, make 4.4, dependências do Chromium.
- O usuário foi adicionado ao grupo `docker`; até o próximo login, use
  `sg docker -c "<comando>"` ou abra uma nova sessão.
- Cluster: `kind-kubora-dev` (recriar com
  `kind create cluster --name kubora-dev`; remover com
  `kind delete cluster --name kubora-dev`). A máquina tem 3,3 GB de RAM, então
  manter apenas um cluster por vez.
