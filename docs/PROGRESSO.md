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

### 02/11/2026 — Login por usuário e senha (pedido do responsável)
- **Contas locais para o modo local:** `kubeviz user add|remove|list` grava em
  `~/.config/kubeviz/users` (formato htpasswd com bcrypt custo 12, permissão
  0600, escrita atômica); a senha é pedida duas vezes sem eco (ou lida da
  entrada padrão em scripts). Mínimo de 12 caracteres.
- Com ao menos uma conta, a tela de login pede usuário e senha e o **link com
  token deixa de valer**; sem contas, nada muda. O arquivo é relido quando
  muda: criar ou remover contas vale **sem reiniciar**.
- **Proteções:** 5 senhas erradas em 15 min bloqueiam o IP e o usuário (429 com
  `Retry-After`); usuário inexistente custa o mesmo tempo que senha errada
  (não revela quais contas existem); mensagens genéricas; recusas no log.
- A sessão guarda a conta local; o cabeçalho mostra a conta e a dica mostra a
  identidade no Kubernetes (a do kubeconfig). `GET /api/v1/auth/session` passa
  a informar `loginMethods` (`link`, `password` ou `token`).
- **Escopo:** só o modo local. No modo in-cluster continua o login por token
  (contas locais exigiriam impersonation; o login corporativo é a tarefa 1.9).
- **Verificado:** testes Go (contas, limite de tentativas, endpoint, comando
  `kubeviz user`), 104 testes Vitest (formulário, erro, bloqueio) e ponta a
  ponta com o binário numa instância de teste em localhost: troca de link para
  senha sem reiniciar, link antigo 404, arquivo 0600 sem a senha, login, pods ao
  vivo, logout e bloqueio após 5 erros. Captura:
  [img/login-senha.png](img/login-senha.png).

### 02/11/2026 — Tarefa 1.3: detalhe de recurso
- **Página de detalhe genérica** em `/view/<grupo>/<versão>/<recurso>/<nome>?ns=…`
  (grupo core = `core`), para qualquer tipo; o nome de cada linha das listas
  passa a ser um link para ela. O objeto é lido como lista filtrada pelo nome
  (`fieldSelector=metadata.name=…`), então o watch da 1.2 o mantém atualizado.
- **Abas:** Visão geral (metadados, labels, anotações, "pertence a" com link
  para o dono, condições, containers com status e reinícios, nó e IP; dados de
  ConfigMaps); YAML somente leitura (sem `managedFields` por padrão, copiar);
  Eventos do objeto (`involvedObject.uid`), ao vivo.
- **Secrets mascarados por padrão:** valores de `data`/`stringData` e a anotação
  `last-applied-configuration` aparecem como `••••••`; "Mostrar valores" revela
  e mostra os valores decodificados.
- **Verificado:**
  - 114 testes Vitest (detalhe de Deployment e Pod, links de dono e nó,
    eventos, Secret oculto/revelado, YAML, objeto inexistente, navegação a
    partir da lista; mascaramento; todo tipo do catálogo com tradução);
  - varredura no kind: detalhe aberto a partir do primeiro item de 17 tipos,
    com as abas YAML e Eventos, sem erros;
  - corrigidos na conferência visual: link "voltar" com chave de tradução crua
    (`kinds.pods`) e eventos desalinhados;
  - capturas: [img/detalhe-pod.png](img/detalhe-pod.png) e
    [img/detalhe-eventos.png](img/detalhe-eventos.png).
- **Fica para depois:** CRDs (navegação por discovery) entram com a busca
  global (1.8), que já precisa da lista de todos os tipos do cluster.

### 02/11/2026 — Tarefa 1.4a: edição de objetos em YAML
- **Botão Editar** na aba YAML do detalhe: editor **CodeMirror 6** (realce com
  os tokens do tema, busca, erros de sintaxe marcados na linha), carregado só
  quando usado (pacote separado de 428 KB).
- **Decisão: CodeMirror em vez de Monaco** (previsto na arquitetura): ~10× menor,
  sem web workers nem CDN; e **validação pelo próprio cluster** em vez de
  esquema no navegador: dry-run com `fieldValidation=Strict`, que recusa campos
  desconhecidos com o esquema real (inclusive de CRDs).
- **Fluxo:** Validar (server-side apply em dry-run) mostra o diff do que o
  cluster aplicaria; Aplicar só fica disponível para o texto validado; o objeto
  vai sem os campos mantidos pelo cluster (status, uid, managedFields…), com as
  chaves em ordem canônica para o diff não acusar falsas mudanças.
- **Server-side apply** com `fieldManager=kubeviz`. Conflitos de dono de campo
  (409) são explicados e podem ser resolvidos com "Validar forçando", que avisa
  que o gerenciador anterior pode desfazer a mudança. Campos desconhecidos viram
  "Campo desconhecido: .spec.replcas (confira a grafia e a indentação)".
- **Backend:** o filtro de CSRF passou a aceitar os tipos de patch do Kubernetes
  (`application/apply-patch+yaml`, `merge-patch+json`, `strategic-merge-patch+json`,
  `json-patch+json`); continua recusando os tipos "simples" do CORS (texto puro,
  formulários), que permitiriam CSRF.
- **Verificado:**
  - testes Go (tipos de patch pelo proxy; recusa de text/plain e multipart);
    124 testes Vitest (limpeza e ordem do objeto, erros de sintaxe com linha,
    diff, URL e cabeçalhos do apply, conflito e campos desconhecidos; fluxo
    validar → diff → aplicar, conflito → forçar, cancelar);
  - no kind, editando pelo navegador: o cluster acusou que `.spec.replicas`
    pertence ao `kubectl` (do `kubectl scale`); forçando, aplicou 3 réplicas e o
    KubeViz passou a constar como gerenciador; `replcas` (erro de digitação) foi
    recusado com a mensagem clara; YAML inválido desabilita Validar;
  - corrigidos na conferência visual: cores do editor ilegíveis no tema escuro
    e diff acusando `apiVersion` por ordem de chaves;
  - captura: [img/editar-yaml.png](img/editar-yaml.png).

### 02/11/2026 — Tarefa 1.4b: aplicar YAML novo
- **Página "Aplicar YAML"** (menu Ferramentas, `/apply`): colar ou importar um
  arquivo `.yaml/.yml/.json` com um ou vários documentos (inclusive `kind: List`);
  namespace padrão para objetos sem namespace; namespace ignorado (com aviso)
  em tipos sem namespace.
- **Descoberta agregada** (`lib/k8s/discovery.ts`, apidiscovery.k8s.io/v2):
  duas chamadas (`/api`, `/apis`) indexam todos os tipos do cluster por
  `apiVersion/Kind`, inclusive CRDs. Será reaproveitada na busca global (1.8).
- **Validar em lote:** para cada documento, consulta o objeto atual e faz
  server-side apply em dry-run; mostra **Novo**, **Alterado** (com diff),
  **Sem mudanças** ou o erro. Objetos cujo namespace é criado no próprio lote
  aparecem como **Aguarda namespace** em vez de erro (o dry-run não cria o
  namespace). Problemas por documento: sem `apiVersion/kind`, sem nome
  (`generateName` não é aceito pelo SSA), tipo desconhecido pelo cluster,
  sintaxe.
- **Aplicar** na ordem do arquivo, só depois de validar o mesmo texto; cada
  objeto aplicado vira link para o detalhe; conflitos usam o mesmo "Validar
  forçando" da 1.4a.
- `hack/demo/exemplo-app.yaml`: exemplo (namespace + ConfigMap + Deployment +
  Service), usado nas capturas.
- **Verificado:**
  - 130 testes Vitest (descoberta: core, grupos, CRDs e recusa sem v2;
    preparação: vários documentos, List, namespace completado/ignorado,
    problemas por documento; página: novo / aguarda namespace / alterado com
    diff, ordem de aplicação, tipo desconhecido bloqueia);
  - no kind, pelo navegador: o exemplo foi validado (1 novo, 3 aguardando o
    namespace), aplicado (4 objetos; `kubectl` confirma conteúdo e
    gerenciador `kubeviz`) e, validado de novo, "nada para mudar"; namespace de
    teste removido em seguida;
  - corrigido: ao validar de novo na mesma página, o resultado anterior era
    exibido (e recontado) durante a validação; o resumo passou a contar os que
    aguardam namespace e os com erro;
  - captura: [img/aplicar-yaml.png](img/aplicar-yaml.png).

### 02/11/2026 — Tarefa 1.5: logs
- **Aba Logs no detalhe de pods** (`?tab=logs`): seletor de container (inclusive
  de inicialização), execução anterior, acompanhar ao vivo, quantidade de
  linhas (100/500/2000/todas), horários, quebra de linha, busca com contagem e
  destaque, download (`.log`). Para containers que reiniciaram, atalho para os
  logs da execução anterior.
- `lib/k8s/logs.ts`: stream de `pods/log` sempre com `timestamps=true`;
  reconexão automática quando o stream cai (container reiniciou) a partir do
  último horário, sem duplicar linhas; códigos ANSI removidos; no máximo 5.000
  linhas na tela. Rolagem automática pausa quando o usuário rola para cima
  ("Ir para o fim"). Mensagens claras para "sem execução anterior" e
  "container ainda não começou".
- Demonstração: novo Deployment `demo/relogio`, que escreve a hora a cada 2 s
  (com cores ANSI).
- **Verificado:**
  - 138 testes Vitest (ANSI, horário, limite de linhas, URL; ao vivo com linha
    partida entre pedaços, busca, execução anterior inexistente, download);
  - no kind: `relogio` recebeu linhas novas ao vivo (160 → 163 em 5 s), sem
    ANSI; busca; `quebrado` mostrou o atalho de reinício e os logs da execução
    anterior ("falhando");
  - **bug encontrado no teste real e corrigido:** quando a resposta terminava
    sem quebra de linha, a última linha era descartada (caso do cluster que já
    tinha descartado os logs anteriores e respondia só com a mensagem de erro);
  - captura: [img/logs-ao-vivo.png](img/logs-ao-vivo.png).

### 02/11/2026 — Tarefa 1.6: terminal no navegador
- **Aba Terminal no detalhe de pods** (`?tab=terminal`): xterm.js (carregado só
  quando usado), container, shell (automático = bash se houver, sh ou bash),
  redimensionamento, conexão só por clique em "Conectar"; mensagens para
  processo encerrado (com código de saída), shell inexistente na imagem e
  conexão recusada (sem `pods/exec`).
- `lib/k8s/exec.ts`: protocolo de exec por WebSocket (`v5.channel.k8s.io`,
  `v4.channel.k8s.io`): canais de entrada, saída, erro, status e tamanho.
- **Backend:** o proxy já repassava upgrades (o Go usa HTTP/1.1 nesses
  pedidos); novos: recusa de WebSocket de outra origem (proteção contra
  Cross-Site WebSocket Hijacking, além do cookie SameSite=Strict) e **registro
  de auditoria** de cada sessão de terminal (usuário, recurso, container,
  comando, origem).
- **Verificado:**
  - testes Go: upgrade de ponta a ponta pelo proxy com eco nos dois sentidos e
    credencial da sessão; origem estranha recusada sem chegar ao cluster; sem
    sessão, 401; registro no log; 142 testes Vitest (protocolo, shell
    inexistente);
  - no kind, por `wss://` com a CSP real: comando executado no pod `web`
    (`kubeviz-42`), `exit 3` informado, `bash` inexistente explicado, usuário
    `dev-limitado` recusado; sessões registradas no log;
  - captura: [img/terminal.png](img/terminal.png).

### 02/11/2026 — Tarefa 1.7: ações
- **Barra de ações no detalhe**, com diálogos acessíveis (Radix Dialog):
  - Deployment: escalar, reiniciar (anotação `restartedAt`, como `kubectl
    rollout restart`), pausar/retomar, voltar revisão (lista de revisões a
    partir dos ReplicaSets, com imagens; JSON patch do template, sem o rótulo
    `pod-template-hash`, como `kubectl rollout undo`);
  - StatefulSet: escalar e reiniciar; DaemonSet: reiniciar; ReplicaSet: escalar;
  - Nó: bloquear/liberar agendamento (cordon/uncordon);
  - qualquer objeto: excluir, exigindo digitar o nome; volta para a lista.
- **Só aparece o que o RBAC permite:** cada botão depende de uma
  `SelfSubjectAccessReview` feita com a credencial do usuário.
- **Auditoria (RF-50):** toda alteração real no cluster feita pelo KubeViz fica
  no log (`alteração no cluster`: usuário, método, recurso, origem); consultas,
  dry-runs e revisões de acesso ficam de fora.
- Botão de confirmação de exclusão com contraste acessível nos dois temas.
- **Verificado:**
  - testes Go (auditoria) e 153 testes Vitest (SSAR, corpos e cabeçalhos de
    cada ação, revisões, rollback; botões por permissão, escalar, excluir com
    nome, rollback, cordon);
  - no kind, pelo navegador, conferido com `kubectl`: escalar para 3; reiniciar
    (revisão 1 → 2 com `restartedAt`); pausar/retomar; voltar para a revisão 1
    (template sem `restartedAt`, revisão 3); cordon/uncordon; excluir um pod de
    teste; `dev-limitado` sem nenhuma ação; tudo registrado na auditoria;
  - **bug encontrado no teste real e corrigido:** o DELETE ia sem corpo e sem
    `Content-Type`, e o backend o recusava (415) pela proteção contra CSRF; agora
    envia `DeleteOptions` em JSON, e o teste confere o cabeçalho;
  - capturas: [img/acao-escalar.png](img/acao-escalar.png) e
    [img/acao-excluir.png](img/acao-excluir.png).

### 02/11/2026 — Tarefa 1.8: busca global, eventos e recursos personalizados
- **Busca global (Ctrl+K ou ⌘K, ou o campo "Buscar recursos…" do cabeçalho):**
  - encontra páginas do menu, tipos de recurso do cluster (pela descoberta da
    API, inclusive CRDs) e objetos pelo nome (pods, deployments, statefulsets,
    daemonsets, jobs, cronjobs, services, ingresses, configmaps, secrets, PVCs,
    service accounts, nós e namespaces);
  - os nomes vêm só com os metadados (`PartialObjectMetadataList`), carregados
    quando a busca abre e guardados por 30 s; tipos sem permissão são ignorados;
  - ordem: nome igual, começa com o termo, contém o termo; ignora acentos;
  - a seleção acompanha o primeiro resultado enquanto os objetos chegam.
- **Página de eventos:** todos ou só avisos (com contagem), namespace, filtro por
  texto (motivo, mensagem, objeto), ao vivo, do mais recente ao mais antigo, com
  link para o objeto envolvido; mostra até 500.
- **Recursos personalizados:** nova página lista os CRDs (tipo, grupo, versões,
  escopo) com link para a **lista genérica** de qualquer tipo
  (`/list/<grupo>/<versão>/<recurso>`), que usa as colunas definidas pelo CRD
  (formato Table). O "voltar" do detalhe e a exclusão levam a essa lista.
- **Demonstração:** `make demo` cria o CRD `widgets.demo.kubeviz.dev` com dois
  objetos (`hack/demo/crd.yaml` e `crd-exemplos.yaml`).
- **Verificado:**
  - 164 testes Vitest (ordenação e permissões da busca, versão servida do CRD,
    endereço das listas; paleta pelo atalho e pelo botão, páginas, CRDs,
    eventos com filtros, tipo desconhecido);
  - no kind, pelo navegador (Playwright), conferido com `kubectl`: 4 avisos
    entre 81 eventos; Widgets alfa/beta com as colunas Cor e Tamanho; busca por
    "web" abrindo o Deployment;
  - **bug encontrado no teste real e corrigido:** os tipos apareciam antes dos
    objetos e ficavam selecionados; agora os objetos vêm primeiro e o Enter abre
    o primeiro resultado;
  - capturas: [img/busca-global.png](img/busca-global.png),
    [img/eventos-avisos.png](img/eventos-avisos.png) e
    [img/crd-widgets.png](img/crd-widgets.png).

### 02/11/2026 — Tarefa 1.9: login corporativo (OIDC)
- **Login OIDC genérico:**
  - botão "Entrar com <provedor>" na tela de login; o login por token (ou o
    link/senha no modo local) continua como alternativa;
  - fluxo de código com PKCE, `state` (uso único, 10 min, ligado ao navegador
    por cookie `SameSite=Lax`) e `nonce`; ID token validado;
  - após o login, volta para a página em que a pessoa estava, só para caminhos
    locais (nunca para outro site).
- **Dois modos:**
  - `impersonate` (padrão): o KubeViz age pelo usuário com os cabeçalhos
    `Impersonate-*`, sem configurar o API server;
    - nomes com prefixo `oidc:`; usuários e grupos `system:*` recusados;
      e-mail precisa estar verificado;
    - o chart cria um ClusterRole só com `impersonate` em users/groups, a
      **única** permissão da ServiceAccount, e só nesse modo;
  - `token`: o ID token é repassado a um API server que confia no provedor.
- **Renovação:**
  - tokens só no servidor, renovados pelo refresh token antes de vencer (o
    `sub` não pode mudar);
  - se a renovação falhar, a sessão acaba; sem refresh token, a sessão dura o
    mesmo que o ID token.
- **Erros explicados na tela de login:** provedor recusou, state inválido,
  usuário sem e-mail verificado, cluster não confia no provedor, KubeViz sem
  permissão de impersonation, provedor fora do ar. Cada login e falha fica no
  log.
- **Configuração:**
  - flags e variáveis `--oidc-*` / `KUBEVIZ_OIDC_*`; o client secret só por
    variável de ambiente ou arquivo;
  - HTTPS obrigatório fora de localhost;
  - no chart, `oidc.*`, com o segredo vindo de um Secret existente e CA
    opcional;
  - guia em [oidc.md](oidc.md).
- **Ambientes de teste:** `hack/oidc/dex.sh` e `hack/oidc/keycloak.sh`
  (`make oidc-dex` / `make oidc-keycloak`), com senhas aleatórias fora do
  repositório e RoleBindings de exemplo no kind.
- **Verificado:**
  - testes Go com um provedor OIDC falso (`internal/auth/oidctest`): PKCE,
    state trocado ou reutilizado, código inventado, nonce, prefixos e
    `system:*`, e-mail não verificado, renovação, troca de `sub`, revogação,
    redirecionamento aberto, cabeçalhos no API server;
  - **envtest (API server real):**
    - impersonation recusada sem a permissão do chart e, com ela, valendo o
      RBAC do usuário;
    - modo token com o kube-apiserver configurado por
      `AuthenticationConfiguration` para confiar no provedor de teste;
  - 167 testes Vitest (botão, retorno à página, mensagens de erro);
  - **Dex** pelo navegador (Playwright), conferido com `kubectl`:
    - ana (só leitura) vê os pods de `demo`, não vê `kube-system` e não tem
      botões de ação;
    - kilgore, pelo grupo `authors`, escala o deployment para 3 (auditoria
      com `usuario=oidc:kilgore@kilgore.trout`);
    - sem permissão de impersonation, a tela mostra o motivo;
  - **Keycloak** pelo navegador: bia, com o grupo `dev`, entra, e a sessão
    continua depois de o ID token de 2 min vencer (renovação real);
  - capturas: [img/login-oidc.png](img/login-oidc.png),
    [img/oidc-grupo-edicao.png](img/oidc-grupo-edicao.png) e
    [img/login-oidc-erro.png](img/login-oidc-erro.png).
- **Fora desta tarefa:**
  - "Sair" encerra a sessão do KubeViz, mas não a do provedor (logout no
    provedor fica para depois);
  - os grupos são lidos no login; mudanças de grupo no provedor valem no
    próximo login;
  - a instância da rede continua com login por senha: o OIDC precisa de um
    provedor acessível pela sua máquina.

### 02/11/2026 — Tarefa 1.10: escala (5.000 pods) — Fase 1 concluída
- **Cenário de carga:**
  - `make scale-up` cria pods simulados pelo kwok no kind (5.000 por padrão,
    em 47 nós falsos; `hack/scale/kwok.sh`);
  - `make scale-down` remove o cenário;
  - `pnpm perf` mede com o Playwright (ver [desempenho.md](desempenho.md)).
- **Problemas encontrados na linha de base:**
  - a lista de 5.110 pods levava 12,7 s, travando a página por 8,7 s;
  - com uma rajada de 500 exclusões, a página **travou por mais de 10 min**:
    cada evento do watch recalculava as 5.000 linhas e redesenhava a tabela
    inteira.
- **Correções:**
  - tabelas virtualizadas a partir de 200 linhas (`VirtualTable`: cabeçalho
    fixo, `aria-rowcount`, ~60 linhas no DOM em vez de 5.110);
  - eventos do watch aplicados em lotes de 100 ms, com índice por objeto;
  - listas sem o compartilhamento estrutural do TanStack Query;
  - `managedFields` descartados nas listas de pods, nas tabelas e nos
    eventos;
  - busca global reaproveitando a lista de pods em cache;
  - ordenação com `Intl.Collator`;
  - resumo da Visão geral memoizado.
- **Resultados com 5.110 pods** (intervalo de três rodadas, numa máquina com 4
  núcleos e 3,3 GB, em swap):
  - filtrar: 0,07–0,88 s (**RNF-05 ✔**);
  - navegar para Pods com cache: 0,15–0,20 s (2,6 s na rodada com swap
    pesado);
  - rajadas do watch: a lista acompanha o cluster, com travamento máximo de
    0,3–1,7 s;
  - busca global: 0,66–0,79 s;
  - backend: 19–26 MB de memória (**RNF-06 ✔**);
  - primeira carga: 2,5–8,6 s nesta máquina. Com as respostas servidas da
    memória, o navegador leva 0,9–1,2 s; o restante é o API server (~0,9 s
    para montar a lista). A meta de 2 s (RNF-04) ainda não foi confirmada.
- **Verificado:**
  - 171 testes Vitest, entre eles:
    - lote com 5.000 linhas e 1.500 eventos em menos de 200 ms;
    - excluir e recriar no mesmo lote;
    - `managedFields` descartados;
    - lista de 1.000 pods desenhando menos de 100 linhas e filtrando entre
      todas;
    - busca usando o cache;
  - medições reais no kind antes e depois de cada mudança;
  - captura: [img/pods-5000.png](img/pods-5000.png).
- **Pendências:**
  - teste com 10 mil pods e confirmação da primeira carga numa máquina maior
    (esta não comporta o kind com 10 mil pods);
  - o cenário de carga foi removido do kind ao final.

### 02/11/2026 — Paginação dos pods e criação de contas na tela de login (pedido do responsável)
- **Paginação na página de Pods:**
  - 50, 100, 250 ou 500 por página (padrão 100, lembrado no navegador);
  - primeira, anterior, próxima e última página, com "301–324 de 324";
  - volta à primeira página ao filtrar ou trocar de namespace;
  - o filtro vale para todos os pods; com 250 ou 500 por página, a tabela
    continua virtualizada.
- **Criar conta na tela de login (modo local):**
  - "Ainda não tem conta? Criar conta" abre um formulário com código do
    terminal, usuário, senha e confirmação;
  - **segurança:** no modo local, quem entra age com o kubeconfig da máquina
    (no kind, administrador do cluster). Por isso a criação exige o código
    exibido no terminal em que o KubeViz foi iniciado (o token do link; dá
    para colar o link inteiro): só quem tem acesso à máquina cria contas,
    como no `kubeviz user add`;
  - códigos errados são limitados por IP (5 em 15 min);
  - nomes já usados são recusados (`AddUser`), para ninguém trocar a senha
    de outra pessoa;
  - a conta já entra logada; o terminal mostra o código também quando já
    existem contas;
  - no modo in-cluster e com OIDC, as contas vêm do cluster ou do provedor;
    não há criação pela tela.
- **Verificado:**
  - testes Go: código errado, link inteiro como código, nome inválido,
    senha curta, nome repetido sem trocar a senha, bloqueio após 5 erros,
    in-cluster sem criação;
  - 175 testes Vitest: formulário, senhas que não conferem, erros, voltar,
    paginação, tamanho de página lembrado;
  - no navegador (Playwright), com 324 pods no kind:
    - código errado recusado;
    - conta criada e já logada;
    - páginas 1–100, 101–200 e 301–324;
    - 250 por página;
    - sair e entrar com a conta nova;
    - arquivo de contas com permissão 600;
  - capturas: [img/criar-conta.png](img/criar-conta.png) e
    [img/pods-paginacao.png](img/pods-paginacao.png).

### 02/11/2026 — Publicação: v0.2.0 e v0.2.1
- **v0.2.0** publicada (tag, imagem amd64/arm64 no GHCR, chart OCI, release
  com notas da Fase 1).
- **Verificação após publicar:** a instalação in-cluster do kind foi
  atualizada com o chart publicado e **falhou** num
  `helm upgrade --reuse-values` vindo da 0.1.0. Com essa opção, o Helm não
  traz os valores padrão novos, então `oidc` chegava vazio e os templates
  quebravam (`nil pointer evaluating .enabled`).
- **v0.2.1:**
  - templates tolerantes a valores antigos (`default dict`/`dig`);
  - `make helm-lint` passa a renderizar também sem `oidc`, reproduzindo o
    erro com os templates antigos;
  - verificado com o upgrade real no kind: pod com a imagem publicada,
    `/api/v1/version` correto e nenhuma permissão extra para a
    ServiceAccount.

### 02/11/2026 — Contas e login com Google, Microsoft, GitHub e OIDC (pedido do responsável)
- **Pedido:** criar usuário com a opção de entrar pelo Google ou por outros
  provedores, sem depender de código do terminal, com instalação e
  configuração o mais simples possível.
- **Viabilidade verificada:**
  - o Google e a Microsoft não aceitam endereço IP no retorno do login (só
    `localhost` ou um domínio). Por isso a instância da rede passa a ter o nome
    `10.11.12.103.nip.io`, com um certificado que o inclui;
  - o cliente OAuth precisa ser criado pelo responsável, na conta dele.
- **Contas (modo local):**
  - arquivo JSON (o formato antigo é lido, e as contas dele viram
    administradoras);
  - cada conta entra com senha e/ou com e-mails confirmados por provedor;
  - papel de administrador conferido a cada pedido; conta removida perde a
    sessão na hora; sempre resta um administrador.
- **Primeiro acesso sem código:**
  - sem contas, a tela de login cria a conta de administrador;
  - exposto na rede, só nos 15 min após iniciar, para ninguém tomar a
    instalação;
  - a criação por código do terminal foi removida.
- **Administração (menu só para administradores):**
  - **Usuários:** criar, editar e remover contas, e liberar domínios;
  - **Provedores de login:** Google, Microsoft, GitHub e OIDC configurados pela
    interface, cada um com passo a passo, endereço de retorno para copiar e
    aviso quando o acesso é por IP. O secret nunca volta para a interface.
- **Login por provedor:**
  - código de autorização com PKCE, `state` (cookie Lax, uso único) e `nonce`;
  - o provedor só confirma o e-mail; quem entra é decidido pelas contas e pelos
    domínios liberados, e outros e-mails são recusados com explicação;
  - Google e OIDC exigem `email_verified`; GitHub usa o e-mail principal
    verificado;
  - na Microsoft, o emissor é conferido por inquilino, e contas de
    organização entram pelo UPN (proteção contra "nOAuth").
- **Ajuste encontrado no E2E:** ao sair, a próxima pessoa voltava para a
  página da anterior (inclusive páginas de administração); agora sair volta à
  página inicial. O aviso "Salvo." dos domínios sumia porque o cartão era
  recriado ao recarregar; corrigido.
- **Verificado:**
  - testes Go: armazenamento e migração, papéis e último administrador,
    e-mails e domínios, primeiro acesso e prazo, API de administração (sem
    expor hashes nem secrets), configuração de provedores, identidade da
    Microsoft, login do GitHub contra uma API falsa e login OIDC de ponta a
    ponta;
  - 182 testes Vitest;
  - **no navegador**, com o Dex fazendo o papel do Google:
    - primeiro acesso;
    - provedor configurado pela interface;
    - conta só com e-mail entrando pelo provedor, sem ver Administração;
    - e-mail sem conta recusado com explicação;
    - domínio liberado criando a conta;
  - capturas: [img/primeiro-acesso.png](img/primeiro-acesso.png),
    [img/admin-usuarios.png](img/admin-usuarios.png),
    [img/admin-provedores.png](img/admin-provedores.png) e
    [img/login-provedores.png](img/login-provedores.png).
- **Pendente (responsável):** criar o cliente OAuth no Google Cloud (e, se
  quiser, na Microsoft e no GitHub) com o endereço de retorno mostrado na
  página, acessando por `https://10.11.12.103.nip.io:4466`. O login real com
  o Google ainda não foi testado.

### 02/11/2026 — Publicação: v0.3.0
- Versão com as contas e os provedores de login do modo local (Google,
  Microsoft, GitHub e OIDC), o primeiro acesso sem código, a paginação dos
  pods e a correção do chart da v0.2.1.
- Verificada depois de publicar, como na v0.2.1: imagem amd64/arm64 no GHCR,
  chart OCI e upgrade real no kind com `helm upgrade --reuse-values` vindo da
  0.2.1.

### 02/11/2026 — Passkeys (pedido do responsável)
- **Contexto:** o responsável perguntou sobre a biblioteca Better Auth.
  - Ela foi descartada: exige um servidor em TypeScript (Node, Bun ou Deno)
    com banco de dados próprio, o que quebraria o binário único sem
    dependências.
  - Do que ela oferece, faltavam as passkeys, implementadas em Go com a
    go-webauthn v0.18.2.
- **Minha conta** (clique no próprio nome): cadastrar passkeys, com nome
  sugerido como "Chrome · Linux", listar (criada, último uso, sincronizada) e
  remover.
- **Entrar com passkey:** na tela de login, sem usuário nem senha.
  - A passkey é residente e exige verificação do usuário.
  - Cada desafio vale uma vez só e por 5 min.
  - O contador de uso detecta clonagem.
  - Tentativas erradas são limitadas por IP.
  - Na lista de usuários, cada conta mostra quantas passkeys tem.
- **Restrições dos navegadores:**
  - a passkey fica ligada ao nome do endereço; por IP, o botão não aparece
    e a página explica o motivo;
  - fora de localhost, é preciso HTTPS com certificado confiável (o Chrome
    bloqueia passkeys com erro de certificado);
  - por isso, `hack/tls/certs.sh` cria uma CA local restrita por nome
    (nameConstraints) e o certificado do servidor;
  - a instância da rede já usa esse certificado; falta o responsável instalar
    o `ca.crt`.
- **Verificado:**
  - testes Go com um autenticador de software (`internal/auth/webauthntest`,
    ES256 com atestação "none"): cadastro (residente, verificação
    obrigatória, desafio de uso único), login sem usuário, recusa de origem
    falsa, de contador que volta atrás e de passkey removida, e endereço IP
    recusado;
  - 188 testes Vitest: conversões base64url ↔ ArrayBuffer, botão de login,
    cancelamento, Minha conta;
  - **no Chromium com autenticador virtual:**
    - em `http://localhost`: cadastro, login sem senha (contador 2), passkey
      removida recusada, e nenhum botão por IP;
    - em `https://10.11.12.103.nip.io` com o certificado da CA local:
      contexto seguro, cadastro e login;
  - capturas: [img/minha-conta-passkeys.png](img/minha-conta-passkeys.png) e
    [img/login-passkey.png](img/login-passkey.png).

### 02/11/2026 — Tarefa 2.1: métricas ao vivo (início da Fase 2)
- **Fonte:** metrics-server (API `metrics.k8s.io`), lido com a credencial de
  quem está logado, como o resto do KubeViz. Sem metrics-server ou sem
  permissão, a página explica o motivo e mostra o comando de instalação.
- **Visão geral:** os blocos de CPU e memória mostram o uso do cluster sobre
  a capacidade alocável dos nós, com link para Métricas.
- **Página Métricas** (atualiza a cada 15 s):
  - CPU e memória em uso e reservadas (requests) no cluster;
  - nós com barras de uso sobre a capacidade e um marcador do total
    reservado;
  - **maiores consumidores** por workload ou por pod, ordenados por CPU ou
    memória, com requests e limits;
  - namespaces.
  Responde "o que está consumindo recursos agora?".
- **Detalhes:**
  - quantidades do Kubernetes lidas em todas as notações (`250m`,
    `123456789n`, `128Mi`, `1e3`…);
  - CPU exibida como `152m` ou `1.5 CPU`;
  - pods de Deployment agrupados pelo nome do ReplicaSet menos o
    `pod-template-hash`;
  - pods terminados não contam como reservas;
  - as barras de uso sobre capacidade mudam de cor a 75% e 90%; as
    comparativas, só entre os itens da lista, têm cor neutra.
- **Demonstração:** `make demo` instala o metrics-server v0.9.0 no kind
  (`hack/demo/metrics-server.sh`, com `--kubelet-insecure-tls`, só para
  desenvolvimento).
- **Gráficos:** a arquitetura previa ECharts e uPlot. As séries temporais
  (2.2) vão usar só o uPlot, pequeno e rápido; o ECharts (~1 MB) fica para
  quando algo exigir.
- **Verificado:**
  - testes de leitura das quantidades, dono dos pods, reservas e somas por
    namespace e por nó;
  - página e Visão geral com e sem metrics-server;
  - 196 testes Vitest no total;
  - no kind, conferido com `kubectl top`.
  - **Encontrado no teste real e corrigido:**
    - os pods estáticos do plano de controle (apiserver, etcd…) têm o nó
      como "dono" e apareciam somados como um único workload; agora cada um
      aparece como ele mesmo;
    - as barras comparativas ficavam vermelhas no primeiro da lista, o que
      sugeria um problema inexistente.
  - capturas: [img/metricas.png](img/metricas.png) e
    [img/visao-geral.png](img/visao-geral.png).

### Resumo da Fase 1
Navegação e operação completas: listas genéricas e CRDs, tempo real,
detalhe, edição e aplicação de YAML, logs, terminal, ações com RBAC, busca
global, eventos, login OIDC e escala para 5.000 pods. Próximo passo: Fase 2
(performance e uptime, [roadmap](05-roadmap.md)).

## Próximas tarefas (Fase 2 — Performance e uptime)

Escopo no [roadmap](05-roadmap.md#fase-2--performance-e-uptime-68-semanas--v03)
e nos requisitos RF-30 a RF-36. Fica pronta quando o KubeViz responder, sem
Grafana, "o que está consumindo recursos?" e "qual foi a disponibilidade do
serviço X no último mês?".

1. **2.1 — Métricas ao vivo:**
   - CPU e memória por nó, namespace e pod (metrics-server), comparados com
     requests, limits e capacidade;
   - blocos de CPU e memória na Visão geral;
   - página Métricas com os maiores consumidores.
2. **2.2 — Coletor embutido e histórico:**
   - SQLite, amostras a cada 30 s com retenção configurável;
   - gráficos (uPlot) com seletor de período de 15 min a 30 d;
   - acesso conferido pelo RBAC de quem consulta.
3. **2.3 — Prometheus:** detecção (endereço configurado ou Service) e
   consultas PromQL prontas, usadas no lugar do coletor quando houver.
4. **2.4 — Indicadores e métricas no detalhe:**
   - reinícios, OOMKilled, pods pendentes e nós NotReady;
   - aba de métricas no detalhe de pods, workloads e nós.
5. **2.5 — Uptime:**
   - estado de workloads (réplicas prontas) e nós (Ready);
   - histórico de transições, % em 24 h, 7 d e 30 d, linha do tempo.
6. **2.6 — Sondas sintéticas:** HTTP/TCP configuráveis (intervalo, timeout,
   código esperado), combinadas com o estado do Kubernetes no uptime.
7. **2.7 — Escala e fechamento:** coletor e uptime com 5.000 pods (backend
   abaixo de 256 MB), documentação e versão.

Pendências da Fase 1, que podem ser retomadas a qualquer momento:
- teste com 10 mil pods e confirmação da primeira carga (< 2 s) numa máquina
  maior;
- logout também no provedor OIDC.

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
