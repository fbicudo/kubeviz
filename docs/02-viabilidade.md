# 2. Análise de viabilidade

**Conclusão:** o projeto é **viável tecnicamente** e de **viabilidade de mercado
moderada**, condicionada a um diferencial claro em relação ao Headlamp. Pesquisa de
mercado feita em nov/2026.

## 2.1 Panorama de mercado (nov/2026)

| Ferramenta | Tipo | Licença | Situação | Observações |
|------------|------|---------|----------|-------------|
| **Kubernetes Dashboard** | Web | Apache-2.0 | **Arquivado** (jan/2026) | Sem patches de segurança. Deixou uma base grande de usuários procurando substituto |
| **Headlamp** | Web + desktop | Apache-2.0 | Ativo (v0.45, ago/2026), CNCF Sandbox, kubernetes-sigs | Sucessor recomendado pelo SIG UI. Navegador de recursos + mapa; métricas, Helm, Flux etc. via plugins instalados à parte |
| **Freelens** | Desktop (Electron) | MIT | Ativo | Fork do OpenLens; não é web |
| **Lens** | Desktop | Proprietário | Pago por usuário para uso comercial | — |
| **Rancher** | Web (plataforma) | Apache-2.0 | Ativo | Muito completo, mas pesado; gerencia ciclo de vida de clusters |
| **Portainer** | Web | Zlib (CE) / comercial | Ativo | Recursos de governança fortes na edição paga |
| **KubeSphere, Devtron, Kubevious, kubewall, Radar** | Web | Variadas | Ativos | Nichos específicos (plataforma, CI/CD, topologia, histórico) |
| **Octant** | Web | Apache-2.0 | Arquivado (2022) | — |

### Lacunas identificadas (oportunidade)

1. **Performance e uptime nativos.** As ferramentas leves mostram apenas o
   instantâneo do metrics-server; histórico e disponibilidade (SLA) exigem montar
   Prometheus + Grafana separadamente.
2. **Configuração guiada.** Nenhuma das ferramentas leves tem assistentes que levem
   o usuário do "quero publicar minha aplicação" até um conjunto de manifests
   correto (Deployment + Service + Ingress + HPA + probes + limites), com validação.
3. **Público lusófono.** Pouca ou nenhuma documentação/interface em português.

### Riscos de mercado

- O Headlamp tem respaldo oficial e da Microsoft; competir de frente como
  "navegador de recursos" tende a não ter tração.
- **Alternativa a considerar:** entregar os diferenciais (métricas/uptime/wizards)
  como **plugins do Headlamp**. Reduz o esforço em ~40–60% e aproveita a base de
  usuários, mas limita a identidade visual, a arquitetura e o controle do produto.
  **Decisão (P1):** produto próprio. O diferencial precisa ficar evidente desde a
  primeira versão pública.

## 2.2 Viabilidade técnica

| Requisito | Como se resolve | Risco |
|-----------|-----------------|-------|
| Ler/alterar qualquer recurso | API REST do Kubernetes + discovery (inclui CRDs) | Baixo |
| Tempo real | *Watch*/informers no backend → WebSocket para o navegador | Baixo |
| Logs e terminal | Subrecursos `pods/log` e `pods/exec` (WebSocket) | Baixo |
| Métricas instantâneas | API `metrics.k8s.io` (metrics-server) | Baixo |
| Métricas históricas | Prometheus existente (PromQL) **ou** coletor embutido leve | Médio |
| Uptime | Cálculo a partir do estado dos recursos + sondas sintéticas, com histórico persistido | Médio |
| Assistentes seguros | Geração de manifests + *server-side dry-run* + *server-side apply* + diff | Baixo/médio |
| Respeitar RBAC | Repasse do token do usuário ou *impersonation*; `SelfSubjectAccessReview` para habilitar/ocultar ações na UI | Médio (segurança) |
| Login corporativo | OIDC (Keycloak, Entra ID, Google, Okta, Dex) | Médio |
| Performance em clusters grandes | Cache por informers, paginação, virtualização de listas | Médio |
| Compatibilidade entre distribuições | Testes em kind/k3s/EKS/AKS/GKE/OpenShift; suportar as 3 últimas versões do Kubernetes | Médio |

Não há bloqueador técnico. Os pontos de risco médio são conhecidos e têm soluções
consolidadas no ecossistema.

## 2.3 Riscos e mitigação

| # | Risco | Prob. | Impacto | Mitigação |
|---|-------|-------|---------|-----------|
| R1 | Falta de diferencial frente ao Headlamp | Média | Alto | Foco em métricas/uptime/wizards; decidir P1 antes de codar |
| R2 | Falha de segurança (escalada de privilégio pela console) | Baixa | Crítico | Nunca usar ServiceAccount privilegiada para ações do usuário; impersonation; auditoria; testes de RBAC automatizados; revisão de segurança antes do 1.0 |
| R3 | Consumo de memória em clusters grandes | Média | Médio | Informers sob demanda, *metadata-only* quando possível, limites configuráveis, testes de carga com 10k+ pods |
| R4 | Dependência do Prometheus para histórico | Média | Médio | Coletor embutido opcional com retenção curta (ex.: 7 dias) |
| R5 | Escopo crescer sem controle | Alta | Alto | MVP fechado (doc 1), roadmap por fases, critérios de pronto |
| R6 | Sustentabilidade do open source (manutenção) | Média | Alto | Governança simples, CONTRIBUTING, CI forte, releases previsíveis |
| R7 | Mudanças de API entre versões do Kubernetes | Baixa | Médio | Uso de discovery; matriz de testes com 3 versões |

## 2.4 Viabilidade operacional (deploy)

Atende ao requisito de "fácil deployment":

- **No cluster:** `helm install kubora oci://ghcr.io/<usuario>/charts/kubora` → 1 Deployment,
  1 Service, ServiceAccount com permissões mínimas, Ingress opcional.
- **Local:** `kubora` (binário) ou `docker run` usando o kubeconfig do usuário,
  abrindo `http://localhost:4466`.
- Imagem de container estimada em 30–50 MB (distroless), sem dependências externas
  obrigatórias. SQLite embutido para configurações e histórico de uptime; PostgreSQL
  opcional para alta disponibilidade.

## 2.5 Estimativa de esforço

Premissas: **um desenvolvedor com assistência do Claude** (decisão P4), **com
dedicação variável**, conforme a disponibilidade de tokens (decisão P18), sem
designer dedicado (o visual parte do shadcn/ui e de um protótipo validado na
Fase 0), produto próprio (não plugin).

Como a dedicação varia, o esforço é medido em **semanas de trabalho equivalentes
a tempo integral**, não em datas. O prazo no calendário depende do ritmo real.

A assistência de IA acelera bastante a escrita de código, testes e documentação,
mas não elimina o que depende de uma pessoa: decidir, revisar, testar em clusters
reais, validar a UX e responder à comunidade. Por isso a redução em relação a uma
equipe de duas pessoas é parcial.

| Fase | Esforço (semanas de trabalho) |
|------|-------------------------------|
| 0. Fundação (repositório, CI, design system, autenticação, esqueleto, governança) | 4–5 semanas |
| 1. Navegação de recursos, YAML, logs, exec, eventos, OIDC | 7–9 semanas |
| 2. Métricas, uptime e sondas sintéticas | 6–8 semanas |
| 3. Assistentes de configuração (8 assistentes, incluindo NetworkPolicy visual e boas práticas) | 8–10 semanas |
| 4. Endurecimento: segurança, performance, docs, release 1.0 | 4–5 semanas |
| **Total MVP** | **~29 a 37 semanas** (≈ 7 a 9 meses se fosse em tempo integral) |

**Recomendações para reduzir o risco do prazo:**

- Publicar versões `v0.x` utilizáveis ao fim de cada fase, para atrair usuários e
  contribuidores cedo, em vez de esperar a 1.0.
- Se o prazo apertar, mover para depois da 1.0 primeiro a NetworkPolicy visual e a
  verificação de boas práticas: são os assistentes mais trabalhosos.
- Revisão de segurança externa (ou de um voluntário experiente da comunidade) antes
  da 1.0, já que não há segunda pessoa revisando o código.

A alternativa de construir como plugins do Headlamp (~2,5 a 4 meses) foi avaliada e
descartada em favor de produto próprio (decisão P1).

Custos de infraestrutura do projeto são baixos: GitHub (gratuito para open
source), GitHub Actions, registry de containers (GHCR) e clusters de teste efêmeros
com kind no CI.
