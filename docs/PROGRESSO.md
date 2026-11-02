# Progresso do KubeViz

Ponto de partida de cada sessão de trabalho: o que foi feito, o que vem a seguir
e o que está bloqueado. Atualize ao fim de cada tarefa.

**Fase atual:** 1 — Navegação e operação (Fase 0 concluída em 02/11/2026, `v0.1.0`) ([roadmap](05-roadmap.md#fase-1--navegação-e-operação-79-semanas--v02))

## Concluído

### 02/11/2026 — Tarefa 0.1: esqueleto do repositório
- Repositório git, licença Apache-2.0, `CONTRIBUTING`, `CODE_OF_CONDUCT`
  (Contributor Covenant 2.1), `SECURITY`, `GOVERNANCE`, `MAINTAINERS`, modelos de
  issue e PR, `.editorconfig`, `Makefile`, CI do GitHub Actions.
- **Backend Go** (`backend/`, módulo `github.com/fbicudo/kubeviz/backend`): configuração por
  flags/ambiente (`KUBEVIZ_*`), servidor HTTP com encerramento gracioso, logs
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
  [img/visao-geral.png](img/visao-geral.png) e [img/pods-claro.png](img/pods-claro.png).
- Contato do Código de Conduta definido: fbicudo@gmail.com.
- Cluster de desenvolvimento `kind-kubeviz-dev` (Kubernetes 1.37, 1 nó) criado e
  definido como contexto atual do kubectl.

### 02/11/2026 — Tarefa 0.2: conexão com o cluster
- **Pacote `internal/cluster`** (client-go 0.37): modos `local` (kubeconfig) e
  `in-cluster` (ServiceAccount), com detecção automática (`--mode auto`). Troca
  de contexto em memória, sem alterar o kubeconfig do usuário. Consulta
  `/version` com timeout de 5 s; erros de conexão aparecem no estado, não
  derrubam o servidor.
- **Novas flags:** `--context` e `--mode` (env `KUBEVIZ_CONTEXT`, `KUBEVIZ_MODE`).
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
  - capturas: [img/visao-geral.png](img/visao-geral.png) e
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
  token do próprio usuário é repassado à API; a ServiceAccount do KubeViz não
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
    KubeViz não é usada; cabeçalhos `Impersonate-*` do navegador são descartados;
  - de ponta a ponta no kind (modo local): 401 sem sessão e com token errado;
    link correto redireciona para `/` com cookie `HttpOnly`; proxy lista os 8
    pods de `kube-system`; logout encerra o acesso;
  - capturas: [img/login-local.png](img/login-local.png) e
    [img/visao-geral.png](img/visao-geral.png).
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
  - capturas: [img/visao-geral.png](img/visao-geral.png),
    [img/pods-admin.png](img/pods-admin.png),
    [img/pods-sem-permissao.png](img/pods-sem-permissao.png) e
    [img/pods-limitado-demo.png](img/pods-limitado-demo.png).
- **Limitações conhecidas:** listas sem virtualização e sem watch (Fase 1);
  o seletor de contexto e de namespace usam `<select>` nativo (tarefa 0.6).

### 02/11/2026 — Projeto renomeado para KubeViz
- Nome anterior: Kubora. Trocados nome exibido, binário (`kubeviz`), módulo Go
  (`github.com/fbicudo/kubeviz/backend`), variáveis de ambiente (`KUBEVIZ_*`), cookie de sessão
  (`kubeviz_session`), chaves do `localStorage` e documentação. Verificação do
  nome em [06 §6.2](06-perguntas-em-aberto.md#62-verificação-do-nome-kubeviz-02112026).
- Cluster kind recriado como `kubeviz-dev`. O cenário de demonstração passou a
  ser versionado em `hack/demo/` e aplicado com `make demo`.
- Capturas de pods e da visão geral refeitas com o novo nome; as capturas das
  tarefas 0.1 a 0.3 ainda mostram "Kubora".
- A pasta local do projeto continua `~/k8s-console`; renomear quando o
  repositório for criado no GitHub.

### 02/11/2026 — Tarefa 0.5: imagem, Helm chart e HTTPS — critério da Fase 0 cumprido
- **HTTPS nativo** (`--tls-cert-file`/`--tls-key-file`, env `KUBEVIZ_TLS_*`):
  TLS 1.2+, HTTP/2, HSTS, cookie `Secure`; o certificado é relido quando o
  arquivo muda (renovação pelo cert-manager sem reiniciar). Decisão: o próprio
  KubeViz serve TLS, em vez de depender de um Ingress; o Ingress continua
  disponível no chart.
- **Imagem** (`Dockerfile`, `make image`): build em 3 estágios, compilação
  cruzada (amd64/arm64), distroless `static-debian13:nonroot`, usuário 65532,
  **47 MB**. Requer BuildKit (`docker-buildx` instalado pelo apt).
- **Helm chart** (`deploy/helm/kubeviz`): Deployment com raiz somente leitura,
  sem privilégios e com seccomp; probes HTTPS; Service 443; Ingress opcional;
  certificado autoassinado gerado pelo chart (só para testes) ou Secret
  existente (`tls.secretName`). **A ServiceAccount do KubeViz não recebe nenhuma
  permissão**: cada requisição usa o token do próprio usuário. Alvos
  `make helm-lint` e `make kind-install`.
- **Cenário de demonstração:** novo usuário `demo/leitor`, com o papel padrão
  `view` (leitura em todo o cluster, sem secrets e sem nós).
- **Verificado no kind (modo in-cluster, HTTPS via port-forward):**
  - `kubectl auth can-i` confirma que a ServiceAccount do KubeViz não lista
    pods nem lê secrets;
  - certificado com os nomes do Service e o IP da máquina; HSTS presente;
  - sessão sem login → tela de token; link do modo local → 404; token inválido
    → 401; cookie `Secure`;
  - `dev`: 200 em pods de `demo`, 403 em todos os namespaces;
  - `leitor`: 14 pods em todos os namespaces, 403 em secrets e em nós (a visão
    geral mostra "sem permissão" no indicador de nós);
  - capturas: [img/login-token.png](img/login-token.png),
    [img/incluster-dev-pods.png](img/incluster-dev-pods.png) e
    [img/incluster-leitor-overview.png](img/incluster-leitor-overview.png).
- **Campo de token mascarado** (tipo senha): a primeira captura da tela de login
  mostrava parte de um token em texto aberto; o token não deve ficar visível
  para quem olha a tela.
- **Testes novos:** HTTPS de ponta a ponta, certificado inválido e recarga do
  certificado (mantém o anterior se o novo estiver corrompido).
- **CI:** validação do chart e build da imagem para amd64 e arm64 (sem publicar).
- **Não verificado:** Ingress com TLS (o kind não tem controlador de Ingress
  instalado; só validado por `helm template`); build arm64 (só no CI); CI no
  GitHub como um todo (repositório não publicado).

### 02/11/2026 — Tarefa 0.6: revisão visual
- **Identidade visual escolhida:** logo "lente sobre nós" (lupa sobre um grafo
  de três nós, `frontend/public/favicon.svg`, cópia em `docs/img/logo.svg`) e
  **azul** como cor de destaque (`#60a5fa` no tema escuro, `#1d4ed8` no claro).
  A cor de informação passou a ciano, para não se confundir com o destaque.
- **Acessibilidade de cor:** a auditoria encontrou o texto `subtle` (legendas,
  dicas, rótulos do menu) entre 2,7 e 3,3:1, abaixo do mínimo WCAG AA de 4,5:1.
  Ajustados `subtle`, `muted` e, no tema claro, `ok` e `warn`. Novo teste
  automático verifica as 50 combinações de texto e fundo dos dois temas (e o
  texto do botão primário); conferido falhando com a cor antiga.
- **Seletores com busca:** contexto (cabeçalho) e namespace (Pods) usam um
  combobox acessível pelo teclado (Radix Popover + cmdk). Sem permissão para
  listar namespaces, digita-se o nome e escolhe-se "Usar …".
- **Cluster fora do ar:** os indicadores de nós e pods passaram a dizer
  "Cluster inacessível" em vez de ficar em "carregando".
- **Capturas automatizadas:** `pnpm screenshots` (`frontend/scripts/screenshots.mjs`,
  Playwright) gera as 11 imagens de `docs/img` a partir das instâncias local e
  in-cluster com o cenário de demonstração; falha se houver erro na página. As
  capturas antigas com o nome "Kubora" foram substituídas ou removidas. O
  cenário ganhou o contexto `inacessivel` para a captura do estado de erro.
- **Verificado:** 86 testes Vitest; capturas revisadas uma a uma —
  [img/visao-geral.png](img/visao-geral.png),
  [img/seletor-namespace.png](img/seletor-namespace.png),
  [img/pods-claro.png](img/pods-claro.png) e
  [img/cluster-inacessivel.png](img/cluster-inacessivel.png).

### 02/11/2026 — Tarefa 0.7: publicação — Fase 0 concluída
- **Repositório público:** https://github.com/fbicudo/kubeviz (criado vazio pelo
  responsável; código enviado com o histórico completo). Relato privado de
  vulnerabilidades ativado; descrição e tópicos configurados.
- **Antes de publicar:**
  - varredura de segredos em todo o histórico (tokens JWT e do GitHub, chaves
    privadas, links com token, credenciais de kubeconfig): nada encontrado;
    imagens conferidas, inclusive a versão da tela de login no commit `6f2eca5`;
  - o IP da rede local saiu da documentação atual (continua em commits
    antigos; endereço privado, sem risco relevante);
  - **módulo Go trocado para `github.com/fbicudo/kubeviz/backend`**, porque o
    domínio `kubeviz.dev` não foi registrado; feito antes da publicação para
    não quebrar usuários depois.
- **Workflow de release** (`.github/workflows/release.yml`): uma tag `vX.Y.Z`
  publica a imagem `ghcr.io/fbicudo/kubeviz` (amd64 e arm64, SBOM e
  proveniência), o chart `oci://ghcr.io/fbicudo/charts/kubeviz` e a release no
  GitHub, usando só o token temporário do Actions.
- **Verificado:**
  - primeiro CI no GitHub verde em 5,5 min (lint, testes, envtest, chart, imagem
    multi-arquitetura);
  - release `v0.1.0` publicada; imagem e chart **públicos** e baixáveis sem login;
  - instalação no kind só com o que foi publicado (`helm install ... oci://ghcr.io/fbicudo/charts/kubeviz --version 0.1.0`):
    pod com a imagem do GHCR, versão `v0.1.0`, RBAC preservado (dev: 200 em
    `demo`, 403 em todos os namespaces).
- **Ajuste posterior:** a data de build da `v0.1.0` saiu como `unknown`; o
  workflow passa a enviar a data do commit a partir da próxima versão.

### Resumo da Fase 0
Critério de pronto ("instala via Helm em kind e lista pods com o RBAC do
usuário") cumprido com a versão publicada. Entregue: binário único (API + UI),
modos local e in-cluster, login com sessões seguras, proxy autenticado,
lista de pods, HTTPS, imagem de 47 MB, Helm chart sem permissões para a
ServiceAccount, identidade visual, CI e release automatizados. Testes: Go
(unidade, envtest de RBAC, integração com kind) e 86 no frontend.

### 02/11/2026 — Tarefa 1.1: listas genéricas
- **15 páginas do menu** passaram a listar recursos de verdade (eram
  placeholders): nós, namespaces, eventos, deployments (+ ReplicaSets),
  StatefulSets, DaemonSets, Jobs/CronJobs, Services (+ EndpointSlices),
  Ingress/IngressClasses/Gateways/HTTPRoutes, NetworkPolicies, PVCs/PVs,
  StorageClasses, ConfigMaps, Secrets e RBAC (ServiceAccounts, Roles,
  RoleBindings, ClusterRoles, ClusterRoleBindings).
- **Decisão: formato Table da API** (`Accept: application/json;as=Table;v=v1;g=meta.k8s.io`),
  o mesmo do `kubectl get`. O cluster define as colunas de cada tipo,
  inclusive de CRDs, sem código específico; colunas de prioridade > 0 aparecem
  em "Mais colunas" (como `-o wide`). Em Secrets, a resposta traz só metadados,
  nunca os valores.
- `lib/k8s/catalog.ts`: tipos de recurso (grupo, versão, escopo) e páginas.
  `pages/Resources.tsx`: lista genérica com abas (`?k=`), namespace (`?ns=`),
  filtro, status coloridos, idade para colunas de data e mensagens de 403 e de
  extensão não instalada (404). Seletor de namespace e mensagens de erro
  extraídos para `components/resources/common.tsx` (Pods usa os mesmos).
- **Verificado:**
  - 95 testes Vitest (9 novos);
  - varredura no kind das 26 abas: como administrador, contagens reais e
    Gateway API "não instalada"; como `dev-limitado`, 403 em todas (só lê pods);
    nenhum erro de página;
  - capturas novas: [img/recursos-deployments.png](img/recursos-deployments.png)
    e [img/recursos-rbac.png](img/recursos-rbac.png);
  - corrigidos na conferência visual: nomes quebrando em duas linhas e datas
    cruas (ISO) em vez de idade.
- **Limitações:** clicar numa linha ainda não abre o detalhe (1.3); listas se
  atualizam a cada 10 s, sem watch (1.2).

### 02/11/2026 — Tarefa 1.2: tempo real
- **Watch pela API** (`lib/k8s/watch.ts`): a lista carrega normalmente e, a
  partir do seu `resourceVersion`, abre um watch (stream NDJSON) cujos eventos
  são aplicados ao cache (ADDED, MODIFIED, DELETED, BOOKMARK). Reconecta quando
  o servidor encerra o stream; com `410 Gone`, recarrega a lista; com erro de
  rede, tenta de novo com espera crescente (1 s a 30 s); sem permissão de watch
  (403) ou sem `resourceVersion`, volta à consulta a cada 10 s.
- Com o watch ativo, a consulta periódica é desligada. Funciona também no
  formato Table (listas genéricas), na página de Pods e nos indicadores da
  visão geral. Indicador "Ao vivo" / "Conectando…" / "A cada 10 s" nas listas.
- Idades ("3m") passam a ser recalculadas a cada 30 s por um relógio, já que a
  lista não é mais recarregada.
- **Backend:** novo teste garante que o proxy repassa cada evento do stream sem
  acumular (atravessando todos os middlewares).
- **Verificado:**
  - 102 testes Vitest (unidade: eventos partidos entre pedaços, inclusive
    caracteres multibyte; aplicação de eventos a listas e Tables; integração:
    pods surgindo e sumindo por eventos, recuo para consulta com 403);
  - no kind, com `kubectl scale`: pod novo na lista em 0,5 s, pod removido em
    1,4 s, coluna Ready de Deployments em 0,1 s; nenhuma consulta periódica em
    12 s com o watch ativo.
- **Problema evitado:** sem `resourceVersion` (respostas incompletas), o hook
  entrava em laço de recarga; agora recua para consulta periódica.

## Próximas tarefas (Fase 1 — Navegação e operação)

Escopo no [roadmap](05-roadmap.md#fase-1--navegação-e-operação-79-semanas--v02).
Dividido em tarefas pequenas, cada uma testada, commitada e com versão
utilizável:

1. **1.3 — Detalhe de recurso:** metadados, labels, condições, eventos do objeto
   e YAML somente leitura; recursos personalizados (CRDs) via discovery.
2. **1.4 — Edição:** editor YAML (Monaco) com validação, dry-run no servidor,
   diff e server-side apply; aplicar YAML arbitrário.
3. **1.5 — Logs:** em tempo real, multi-container, anteriores, busca e download.
4. **1.6 — Terminal:** exec no navegador (xterm.js + WebSocket pelo proxy, com
   verificação de origem).
5. **1.7 — Ações:** escalar, reiniciar, pausar/retomar, rollback e excluir, com
   confirmação; ações ocultas quando o RBAC não permite.
6. **1.8 — Busca global** (Ctrl+K) e página de eventos com filtros.
7. **1.9 — OIDC:** login corporativo (Keycloak, Dex), com impersonation.
8. **1.10 — Escala:** virtualização das listas e teste de carga com 5.000 pods
    (kwok).

## Como publicar uma versão

```bash
git tag -a vX.Y.Z -m "KubeViz vX.Y.Z" && git push origin vX.Y.Z
```

O workflow de release faz o resto. Conferir depois em
https://github.com/fbicudo/kubeviz/releases.

## Bloqueios e pendências do responsável

| Item | Por quê | Como resolver |
|------|---------|---------------|
| Domínio `kubeviz.dev` (opcional) | Endereço estável para documentação e chart; hoje tudo aponta para o GitHub | Registrar quando quiser; o módulo Go já não depende dele |

## Ambiente de desenvolvimento desta máquina

- Em `~/.local` (PATH configurado em `~/.profile`): Go 1.27.3, Node.js 26.13 LTS,
  pnpm 12.16, kubectl 1.37, Helm 4.3, kind 0.33.
- Pelo apt: Docker 29.1, make 4.4, dependências do Chromium.
- O usuário foi adicionado ao grupo `docker`; até o próximo login, use
  `sg docker -c "<comando>"` ou abra uma nova sessão.
- Capturas de tela: com as duas instâncias no ar, rodar em `frontend/`:
  `KUBEVIZ_LOCAL_URL=... KUBEVIZ_LOCAL_TOKEN=... KUBEVIZ_INCLUSTER_URL=...
  KUBEVIZ_TOKEN_DEV=... KUBEVIZ_TOKEN_LEITOR=... pnpm screenshots`.
- Cenário de demonstração: `make demo` aplica `hack/demo/demo.yaml` (namespace
  `demo` com pods de exemplo e a ServiceAccount `demo/dev`, que só lê pods de
  `demo`) e gera `~/.kube/kubeviz-demo.yaml` (fora do repositório) com os
  contextos `kind-kubeviz-dev` (administrador) e `dev-limitado` (token de 48 h).
  Rodar com `./bin/kubeviz --kubeconfig ~/.kube/kubeviz-demo.yaml`.
- Acesso pela rede, rodando em segundo plano nesta máquina (não sobrevive a
  reinícios):
  - modo local (administrador do kind): `https://<ip-da-maquina>:4466`, com o
    certificado autoassinado em `~/.config/kubeviz/tls/` (fora do repositório);
    o link com token aparece no log de inicialização;
  - modo in-cluster (Helm no namespace `kubeviz`): `https://<ip-da-maquina>:8443`,
    via `kubectl -n kubeviz port-forward --address <ip-da-maquina> svc/kubeviz 8443:443`;
    login com `kubectl create token dev -n demo` ou `... leitor -n demo`.
- Cluster: `kind-kubeviz-dev` (`make kind-up` / `make kind-down`). A máquina tem 3,3 GB de RAM, então
  manter apenas um cluster por vez.
