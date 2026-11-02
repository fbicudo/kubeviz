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

### 02/11/2026 — Tarefa 0.3: autenticação e proxy autenticado
- **Modo local:** link de acesso com token aleatório impresso no terminal a cada
  execução (`/auth/local?token=...`), trocado por sessão; a identidade exibida é
  a do kubeconfig, consultada na hora (muda com o contexto).
- **Modo in-cluster:** `POST /api/v1/auth/login` com token do Kubernetes,
  validado por `SelfSubjectReview`. **Decisão:** em vez de impersonation, o
  token do próprio usuário é repassado à API; a ServiceAccount do Kubora não
  age em nome de ninguém. Impersonation fica para o OIDC (Fase 1).
- **Sessões** (pacote `internal/auth`): em memória, cookie `HttpOnly` +
  `SameSite=Strict` (+ `Secure` atrás de HTTPS), 12 h; `GET /api/v1/auth/session`
  e `POST /api/v1/auth/logout`. Rotas de cluster e contextos passam a exigir sessão.
- **Proxy `/api/k8s/*`:** repassa à API com a credencial da sessão, descartando
  `Authorization`, `Cookie` e `Impersonate-*` do navegador; sem buffer (pronto
  para watch e logs).
- **Interface:** tela de entrada (instruções no modo local; campo de token no
  in-cluster), usuário e botão Sair no cabeçalho; qualquer 401 devolve à tela
  de entrada.
- **Verificado:**
  - testes Go de sessões, login local e in-cluster, logout, cookies e proxy
    (caminho, credenciais e cabeçalhos descartados); 11 testes Vitest;
  - **RBAC com envtest** (`make test-envtest`, API server real v1.37, sem
    Docker): a ServiceAccount `time-a/dev` lê pods de `time-a` e recebe 403 em
    outro namespace, em secrets, na lista de namespaces e ao criar pods; os 403
    citam a própria ServiceAccount, provando que a credencial de administrador do
    Kubora não é usada; cabeçalhos `Impersonate-*` do navegador são descartados;
  - de ponta a ponta no kind (modo local): 401 sem sessão e com token errado;
    link correto redireciona para `/` com cookie `HttpOnly`; proxy lista os 8
    pods de `kube-system`; logout encerra o acesso;
  - capturas: [img/login-local.png](img/login-local.png) e
    [img/autenticado.png](img/autenticado.png).
- **CI:** passo de testes envtest adicionado.
- **Não verificado:** tela de token no modo in-cluster com o binário real (só
  nos testes; o binário in-cluster depende do Helm chart, tarefa 0.5).

### 02/11/2026 — Tarefa 0.4: primeira lista real (pods)
- **Página de Pods** (`/pods?ns=<namespace>`): seletor de namespace (lista os
  namespaces; sem permissão para isso, vira campo de texto), filtro por nome,
  atualização a cada 10 s e botão de atualizar. Colunas: nome, namespace,
  status, prontos, reinícios, idade, nó e IP.
- **Status como no `kubectl get pods`** (`lib/k8s/pods.ts`): motivos de espera e
  término dos containers (CrashLoopBackOff, ImagePullBackOff, Error, ExitCode),
  containers de inicialização, Terminating e Evicted; cor por gravidade.
- **Sem permissão:** mensagem clara com o texto da API e a sugestão de escolher
  um namespace permitido.
- **Visão geral:** indicadores reais de nós prontos e pods em execução, com o
  número de pods com falha (link para a lista). CPU e memória ficam para a
  Fase 2 (métricas).
- **Correção de segurança encontrada no teste visual:** ao trocar de contexto
  (e, portanto, de identidade), dados da identidade anterior podiam continuar
  em cache e a contagem de pods do administrador aparecia para o usuário
  limitado. Agora a troca apaga todos os dados do cluster; há um teste de
  regressão, conferido falhando sem a correção.
- **Erros 4xx deixaram de ser repetidos** automaticamente (a mensagem de
  "sem permissão" aparecia com 1 s de atraso).
- **Verificado:**
  - 34 testes Vitest: 17 de status de pods, idade e prontidão de nós; página
    de Pods (lista, filtro, namespace pela URL e pelo seletor, usuário restrito,
    troca de contexto sem vazamento);
  - no kind, com o namespace `demo` (2 pods nginx, 1 em CrashLoop, 1 com imagem
    inexistente) e a ServiceAccount `demo/dev`, que só lê pods de `demo`:
    administrador vê os 13 pods; o usuário limitado recebe a recusa ao listar
    todos os namespaces e vê os 4 pods ao escolher `demo`;
  - capturas: [img/overview-pods.png](img/overview-pods.png),
    [img/pods-admin.png](img/pods-admin.png),
    [img/pods-sem-permissao.png](img/pods-sem-permissao.png) e
    [img/pods-limitado-demo.png](img/pods-limitado-demo.png).
- **Limitações conhecidas:** listas sem virtualização e sem watch (Fase 1);
  o seletor de contexto e de namespace usam `<select>` nativo (tarefa 0.6).

## Próximas tarefas (Fase 0)

1. **0.5 — Empacotamento:** Dockerfile (distroless, multi-arquitetura) e Helm
   chart com ServiceAccount de permissões mínimas; instalar no kind e testar o
   modo in-cluster, a tela de token e o RBAC pelo navegador (critério de pronto
   da Fase 0). Incluir HTTPS (Ingress com TLS) para acesso pela rede.
2. **0.6 — Revisão visual:** ajustar tokens de cor e densidade, definir logo e
   paleta finais; trocar os `<select>` nativos por componentes com busca.
3. **0.7 — Publicação:** criar o repositório no GitHub, confirmar o CI verde,
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
- Cenário de demonstração no kind: namespace `demo` com pods de exemplo e a
  ServiceAccount `demo/dev` (só lê pods de `demo`). O arquivo
  `~/.kube/kubora-demo.yaml` (fora do repositório) tem os contextos
  `kind-kubora-dev` (administrador) e `dev-limitado` (token de 48 h, gerado em
  02/11/2026). Rodar com `./bin/kubora --kubeconfig ~/.kube/kubora-demo.yaml`.
- Cluster: `kind-kubora-dev` (recriar com
  `kind create cluster --name kubora-dev`; remover com
  `kind delete cluster --name kubora-dev`). A máquina tem 3,3 GB de RAM, então
  manter apenas um cluster por vez.
