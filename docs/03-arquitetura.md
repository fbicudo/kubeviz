# 3. Arquitetura e plataforma recomendada

## 3.1 Visão geral

```
┌──────────────────────── Navegador ─────────────────────────┐
│  SPA React + TypeScript                                     │
│  (páginas, gráficos, editor YAML, assistentes, terminal)    │
└───────────────┬──────────────────────────────┬─────────────┘
                │ HTTPS (REST/JSON)            │ WebSocket (watch, logs, exec)
┌───────────────▼──────────────────────────────▼─────────────┐
│  Backend Go — binário único (serve também os arquivos da UI)│
│                                                             │
│  ┌──────────┐ ┌────────────┐ ┌───────────┐ ┌─────────────┐ │
│  │ Auth     │ │ Proxy +    │ │ Métricas  │ │ Assistentes │ │
│  │ OIDC /   │ │ cache      │ │ metrics-  │ │ templates → │ │
│  │ token /  │ │ (informers)│ │ server /  │ │ dry-run →   │ │
│  │ imperson.│ │            │ │ Prometheus│ │ diff → apply│ │
│  └──────────┘ └────────────┘ └───────────┘ └─────────────┘ │
│  ┌──────────────┐ ┌────────────────┐ ┌──────────────────┐  │
│  │ Uptime       │ │ Coletor embut. │ │ Auditoria        │  │
│  │ (estado +    │ │ (opcional,     │ │ (quem fez o quê) │  │
│  │ sondas HTTP) │ │ retenção curta)│ │                  │  │
│  └──────────────┘ └────────────────┘ └──────────────────┘  │
│                 Armazenamento: SQLite (padrão) | PostgreSQL │
└───────────────┬──────────────────────────────┬─────────────┘
                │                              │
        ┌───────▼────────┐            ┌────────▼────────┐
        │ API Kubernetes │            │ Prometheus      │
        │ (+ metrics API)│            │ (opcional)      │
        └────────────────┘            └─────────────────┘
```

## 3.2 Plataforma recomendada

### Backend: Go

| Critério | Go | TypeScript (Node.js/Bun) |
|----------|----|--------------------------|
| Biblioteca Kubernetes | `client-go` — oficial, usada pelo próprio Kubernetes, informers maduros | `@kubernetes/client-node` — funcional, mas menos completa (informers, SSA, discovery) |
| Desempenho / memória | Alto; ~30–80 MB em idle; concorrência nativa (goroutines) para muitos watches | Bom, mas maior consumo de memória e GC mais sensível com caches grandes |
| Distribuição | Binário estático único; imagem distroless pequena | Requer runtime; imagem maior |
| Ecossistema | Padrão de praticamente todo o tooling CNCF | Menor no domínio Kubernetes |
| Uma linguagem só no projeto | Não (Go + TS) | Sim |

**Recomendação:** Go no backend. O requisito permite "outra linguagem desde que
tenha melhor performance", e Go é a escolha natural para Kubernetes. O custo de ter
duas linguagens é baixo, pois o contrato entre elas é tipado (ver 3.4).

Rust também foi considerado: desempenho ainda maior, mas a biblioteca `kube-rs`
tem um ecossistema menor e a curva de aprendizado reduziria a base de
contribuidores. Não compensa para uma aplicação limitada por I/O.

### Frontend: TypeScript + React

| Camada | Escolha | Motivo |
|--------|---------|--------|
| Build | **Vite** | Rápido, padrão de mercado |
| UI | **React 19** + **TypeScript** | Maior ecossistema e base de contribuidores |
| Componentes | **shadcn/ui** (Radix + Tailwind CSS) | Visual profissional, acessível, código próprio (sem lock-in). Tema próprio no estilo painel de observabilidade: escuro por padrão, alta densidade, tipografia compacta |
| Roteamento / dados | **TanStack Router** + **TanStack Query** | Tipagem forte, cache e revalidação |
| Tabelas | **TanStack Table** + virtualização (**TanStack Virtual**) | Milhares de linhas sem travar |
| Gráficos | **Apache ECharts** (painéis) e **uPlot** (séries temporais densas) | ECharts: rico e acessível; uPlot: muito rápido para tempo real |
| Editor YAML | **CodeMirror 6** + validação pelo próprio cluster (dry-run com `fieldValidation=Strict`) | Decisão da tarefa 1.4: ~10× menor que o Monaco, sem web workers nem CDN (funciona isolado da internet); o cluster valida com o esquema real, inclusive de CRDs |
| Terminal | **xterm.js** | Padrão para `exec` |
| Formulários (assistentes) | **React Hook Form** + **Zod** | Validação declarativa e passo a passo |
| i18n | **i18next** | pt-BR e en desde o início |
| Topologia (fase futura) | **React Flow** | Mapa de relações entre recursos |

### Armazenamento

- **SQLite** embutido (padrão): configurações, histórico de uptime, auditoria,
  séries do coletor embutido. Volume persistente opcional no Helm chart.
- **PostgreSQL** (opcional): para múltiplas réplicas / alta disponibilidade.
- Nenhum dado de recurso Kubernetes é copiado para o banco; a fonte da verdade é
  sempre a API do cluster.

## 3.3 Decisões principais (ADRs resumidos)

| ADR | Decisão | Alternativas descartadas | Justificativa |
|-----|---------|--------------------------|---------------|
| 001 | Backend em Go com `client-go` | Node/Bun, Rust, Java | Ver 3.2 |
| 002 | Frontend React + TS + shadcn/ui | Vue, Angular, MUI | Ecossistema, visual moderno, sem lock-in de biblioteca |
| 003 | Um único binário/imagem serve API e UI | Frontend e backend separados | Deploy mais simples (requisito central) |
| 004 | Ações executadas com a identidade do usuário (token repassado ou impersonation) | ServiceAccount única com permissões amplas | Segurança: a console nunca amplia privilégios |
| 005 | Métricas: Prometheus quando existir; coletor embutido como alternativa | Exigir Prometheus; só metrics-server | Equilíbrio entre facilidade de instalação e histórico |
| 006 | Assistentes geram YAML puro + dry-run + server-side apply | Gerar Helm charts; aplicar sem validação | Transparência, idempotência e compatibilidade com GitOps |
| 007 | Licença Apache-2.0 | MIT, AGPL-3.0 | Padrão CNCF, concessão de patentes, amigável a empresas |
| 008 | Monorepo | Repositórios separados | Contrato de API e versão únicos |

## 3.4 Contrato entre frontend e backend

- API REST própria em `/api/v1/...` descrita em **OpenAPI 3**, com tipos
  TypeScript gerados automaticamente (`openapi-typescript`), evitando divergência.
- Leitura de recursos Kubernetes: rota de *proxy* autenticado para a API do cluster
  (`/api/k8s/...`) com o mesmo formato de resposta, permitindo suportar qualquer
  recurso/CRD sem código específico.
- Tempo real: um único WebSocket multiplexado por aba do navegador, assinando
  watches por tipo/namespace.

## 3.5 Módulos funcionais

### Métricas
1. Detecta se `metrics.k8s.io` está disponível → valores instantâneos.
2. Detecta Prometheus (endereço configurado ou descoberta por Service) → consultas
   PromQL predefinidas para histórico (requer kube-state-metrics, node-exporter e
   cAdvisor, já incluídos no kube-prometheus-stack).
3. Sem Prometheus → coletor embutido amostra o metrics-server a cada 30–60 s e
   guarda N dias no SQLite.

### Uptime / disponibilidade (decisão P6: estado do Kubernetes + sondas)
- **Workload:** disponível quando `readyReplicas >= minimo configurado` (padrão:
  ≥ 1 réplica pronta; opcional: todas as desejadas).
- **Nó:** disponível quando a condição `Ready=True`.
- **Endpoint:** sonda HTTP/TCP sintética executada pelo backend contra
  Service/Ingress, com intervalo e código esperado configuráveis. Quando há sonda
  configurada, o workload só é considerado disponível se as réplicas estiverem
  prontas **e** a sonda responder.
- O mínimo de réplicas prontas é configurável por workload (padrão: ≥ 1).
- Histórico de transições guardado no banco; cálculo de % de uptime em 24 h, 7 d,
  30 d e linha do tempo de incidentes.

### Assistentes
Cada assistente é uma definição declarativa (passos, campos, validações, template
de saída). Fluxo comum:

```
Formulário em passos → gera manifests → valida (schema + dry-run no servidor)
→ mostra YAML e diff → usuário confirma → server-side apply → acompanha rollout
```

O usuário pode, a qualquer momento, baixar o YAML em vez de aplicar (útil para
GitOps).

## 3.6 Segurança

- Autenticação: OIDC (padrão recomendado), token de ServiceAccount/bearer e, no modo
  local, o kubeconfig do usuário.
- **Como está implementado (tarefa 0.3):**
  - *Modo local:* a cada execução o KubeViz gera um token aleatório e imprime no
    terminal um link `/auth/local?token=...`, como o Jupyter. Só quem vê o
    terminal entra; outros usuários da mesma máquina não usam o kubeconfig de
    quem executou o KubeViz. O token é trocado por uma sessão e sai da URL.
  - *Contas locais (modo local):* arquivo JSON (0600) com contas que entram
    com senha (bcrypt) e/ou com e-mails confirmados por provedores (Google,
    Microsoft, GitHub ou OIDC, configurados pela interface); papel de
    administrador conferido a cada pedido; domínios liberados criam contas no
    primeiro acesso. Sem contas, a tela de login cria a de administrador (prazo
    de 15 min após iniciar quando exposto na rede); `kubeviz user add` continua
    para recuperação. Tentativas erradas de senha são limitadas por IP e por
    usuário. Microsoft: contas de organização identificadas pelo UPN (o e-mail
    delas não é verificado, "nOAuth"). Detalhes em
    [login-provedores.md](login-provedores.md).
  - *Modo in-cluster:* login com token do Kubernetes (ServiceAccount ou
    usuário), validado com `SelfSubjectReview`. As requisições seguem para a
    API **com o próprio token do usuário** (repasse), sem nenhuma credencial da
    ServiceAccount do KubeViz. A impersonation fica reservada para o OIDC, quando
    o API server não confia no provedor de identidade.
  - *OIDC (tarefa 1.9):* fluxo de código com PKCE, `state` e `nonce`; ID
    token validado; tokens guardados só no servidor e renovados pelo refresh
    token (falha na renovação encerra a sessão). Dois modos: `impersonate`
    (padrão; a ServiceAccount recebe só a permissão `impersonate`; nomes com
    prefixo `oidc:`; `system:*` recusado) e `token` (ID token repassado a um
    API server que confia no provedor). Detalhes em [oidc.md](oidc.md).
  - *Sessões:* ID aleatório de 256 bits em cookie `HttpOnly`, `SameSite=Strict`
    e `Secure` atrás de HTTPS; duração de 12 h; guardadas em memória (reiniciar
    encerra as sessões; várias réplicas exigirão armazenamento compartilhado). O
    token do usuário nunca volta ao navegador.
  - *Proxy `/api/k8s/*`:* repassa qualquer chamada à API do Kubernetes com a
    credencial da sessão e descarta `Authorization`, `Cookie` e `Impersonate-*`
    vindos do navegador. Watches e logs são repassados sem buffer.
  - *Terminal (exec):* WebSocket repassado pelo proxy com a credencial da
    sessão; WebSockets de outra origem são recusados (além do cookie
    SameSite=Strict); cada sessão de terminal é registrada no log (usuário,
    pod, container, comando, origem); conexão só por clique explícito.
- Autorização: delegada ao RBAC do cluster; a UI consulta
  `SelfSubjectAccessReview`/`SelfSubjectRulesReview` para ocultar ou desabilitar
  ações não permitidas.
- A ServiceAccount da própria console **não tem nenhuma permissão** no login por
  token (tarefa 0.5): o token montado no pod só informa endereço e CA do
  cluster. Permissões são acrescentadas apenas quando necessárias e de forma
  explícita no chart: `impersonate` só com OIDC no modo impersonate (tarefa
  1.9); leitura para métricas e uptime em segundo plano virá na Fase 2.
- HTTPS servido pelo próprio KubeViz (TLS 1.2+, HSTS, recarga automática do
  certificado); Ingress opcional.
- Cookies `HttpOnly`/`Secure`/`SameSite`, proteção CSRF, cabeçalhos CSP.
- Log de auditoria de todas as ações de escrita.
- Secrets mascarados por padrão na UI.
- Imagem assinada (cosign), SBOM publicada, varredura de vulnerabilidades no CI.

## 3.7 Estrutura de repositório proposta

```
kubeviz/
├── backend/            # Go: cmd/, internal/{auth,proxy,metrics,uptime,wizards,store}
├── frontend/           # React + TS (Vite)
├── wizards/            # definições declarativas dos assistentes
├── deploy/helm/        # Helm chart
├── api/openapi.yaml    # contrato da API
├── docs/               # esta documentação + docs de usuário
└── .github/workflows/  # CI: lint, testes, e2e em kind, build multi-arquitetura
```

## 3.8 Qualidade e testes

- Go: testes unitários + `envtest` (API server real em memória).
- Frontend: Vitest + Testing Library; testes visuais de componentes (Storybook).
- E2E: Playwright contra clusters kind no CI, em 3 versões do Kubernetes.
- Testes de RBAC: usuários com diferentes permissões verificam que nenhuma ação
  proibida é possível.
- Testes de carga: cluster sintético com pods simulados pelo kwok (`make scale-up`)
  e medição com Playwright (`pnpm perf`); feito com 5.000 pods na tarefa 1.10, e
  10 mil (o dobro da meta) pendente de uma máquina maior. Ver [desempenho.md](desempenho.md).
- OIDC: testes E2E com Keycloak e Dex.

## 3.9 Governança open source

- Repositório público no GitHub (conta pessoal no início). Se migrar para uma
  organização, o GitHub redireciona o repositório, mas imagens no GHCR e o endereço
  do Helm chart mudam; por isso, publicar a documentação de instalação apontando
  para um domínio próprio do projeto (ex.: `charts.kubeviz.dev`) assim que houver
  nome definitivo.
- Arquivos desde a Fase 0: `LICENSE` (Apache-2.0), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md` (Contributor Covenant), `SECURITY.md` (canal privado para
  vulnerabilidades), `GOVERNANCE.md` simples, modelos de issue e PR.
- DCO (`Signed-off-by`) nos commits, em vez de CLA.
- Roadmap público (GitHub Projects), issues marcadas como `good first issue`.
- Releases versionadas (SemVer) com changelog gerado automaticamente.
- Documentação de usuário em pt-BR e inglês.
