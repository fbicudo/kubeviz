# 4. Requisitos

Prioridade: **M** = obrigatório no MVP, **D** = desejável no MVP, **F** = fase
futura.

## 4.1 Requisitos funcionais

### Acesso e identidade
| ID | Requisito | Prior. |
|----|-----------|--------|
| RF-01 | Login via OIDC genérico; testado oficialmente com Keycloak e Dex (Entra ID, Google, Okta devem funcionar, sem teste automatizado no MVP) | M |
| RF-02 | Login via token bearer / ServiceAccount (acesso alternativo, sem provedor de identidade) | M |
| RF-03 | Modo local usando o kubeconfig do usuário, com troca de contexto | M |
| RF-04 | Ações sempre executadas com a identidade do usuário (RBAC do cluster) | M |
| RF-05 | UI esconde/desabilita ações não permitidas | M |
| RF-06 | Gestão de múltiplos clusters numa mesma instalação | F *(ver P2)* |

### Visão geral e navegação
| ID | Requisito | Prior. |
|----|-----------|--------|
| RF-10 | Painel inicial: nós, capacidade x uso, workloads com problema, eventos de alerta recentes | M |
| RF-11 | Listas de todos os tipos de recurso, incluindo CRDs, com filtro, busca, ordenação e seleção por namespace/labels | M |
| RF-12 | Página de detalhe com status, condições, eventos, recursos relacionados e YAML | M |
| RF-13 | Atualização em tempo real (sem recarregar) | M |
| RF-14 | Busca global (atalho `Ctrl+K`) | M |
| RF-15 | Mapa de topologia de recursos relacionados | F |

### Operação
| ID | Requisito | Prior. |
|----|-----------|--------|
| RF-20 | Editar recurso em YAML com validação por schema e diff antes de salvar | M |
| RF-21 | Escalar, reiniciar (rollout restart), pausar/retomar, rollback de Deployments | M |
| RF-22 | Excluir recurso com confirmação | M |
| RF-23 | Logs em tempo real, multi-container, busca, download, anteriores (`--previous`) | M |
| RF-24 | Terminal (`exec`) no navegador | M |
| RF-25 | Cordon/drain/uncordon de nós | D |
| RF-26 | Port-forward (modo local) | D |
| RF-27 | Aplicar YAML arbitrário (colar/importar arquivo) | M |

### Performance e uptime
| ID | Requisito | Prior. |
|----|-----------|--------|
| RF-30 | Gráficos de CPU e memória (uso, requests, limits) por cluster, nó, namespace, workload e pod | M |
| RF-31 | Gráficos de rede e disco (requer Prometheus) | D |
| RF-32 | Seleção de período (15 min, 1 h, 6 h, 24 h, 7 d, 30 d) e atualização automática | M |
| RF-33 | Detecção automática da fonte de métricas (metrics-server, Prometheus, coletor embutido) | M |
| RF-34 | Uptime por workload e por nó: % em 24 h/7 d/30 d e linha do tempo de indisponibilidades | M |
| RF-35 | Sondas sintéticas HTTP/TCP configuráveis para endpoints (intervalo, timeout, código esperado), combinadas com o estado do Kubernetes no cálculo de uptime | M |
| RF-36 | Indicadores: reinícios de containers, pods pendentes, OOMKilled, nós NotReady | M |
| RF-37 | Página de status pública/compartilhável | F |
| RF-38 | Alertas com notificação (e-mail, Slack, Teams, webhook) | F |

### Assistentes de configuração
| ID | Assistente | Gera | Prior. |
|----|------------|------|--------|
| RF-40 | **Publicar aplicação** | Deployment/StatefulSet, probes, recursos, variáveis, ConfigMap/Secret | M |
| RF-41 | **Expor aplicação** | Service + Ingress ou Gateway API (HTTPRoute), TLS (cert-manager se presente) | M |
| RF-42 | **Autoscaling** | HorizontalPodAutoscaler (com verificação do metrics-server) | M |
| RF-43 | **Novo namespace/projeto** | Namespace + ResourceQuota + LimitRange + RBAC padrão | M |
| RF-44 | **Permissões (RBAC)** | Role/ClusterRole + Binding para usuário, grupo ou ServiceAccount | M |
| RF-45 | **Armazenamento** | PersistentVolumeClaim (com StorageClasses disponíveis) | M |
| RF-46 | **Política de rede** | NetworkPolicy com editor visual de origem/destino | M |
| RF-47 | **Tarefa agendada** | CronJob/Job | D |
| RF-48 | **Verificação de boas práticas** do cluster (sem limits, sem probes, imagens `latest`, privilegiados) | M |
| RF-49 | Instalação de Helm charts / catálogo | F |
| RF-4A | Todos os assistentes: YAML visível, dry-run, diff, opção "baixar em vez de aplicar" | M |

### Administração
| ID | Requisito | Prior. |
|----|-----------|--------|
| RF-50 | Log de auditoria das ações de escrita | M |
| RF-51 | Configurações da console (fonte de métricas, retenção, OIDC) via Helm values e tela de admin | M |
| RF-52 | Idiomas pt-BR e en (estrutura pronta para traduções da comunidade); tema escuro padrão e tema claro | M |

## 4.2 Requisitos não funcionais

| ID | Categoria | Requisito |
|----|-----------|-----------|
| RNF-01 | Implantação | Instalação via um `helm install` ou um binário/`docker run`, sem dependências externas obrigatórias |
| RNF-02 | Implantação | Imagens multi-arquitetura (amd64, arm64), ≤ 60 MB |
| RNF-03 | Compatibilidade | 3 últimas versões menores do Kubernetes; EKS, AKS, GKE, k3s, kind, minikube, kubeadm, RKE2. OpenShift: melhor esforço, fora da 1.0 |
| RNF-04 | Desempenho | Primeira renderização < 2 s; navegação entre páginas < 300 ms com cache |
| RNF-05 | Desempenho | Listas com 5.000 itens filtráveis em < 1 s |
| RNF-06 | Recursos | Backend < 256 MB de RAM em cluster com ~5.000 pods |
| RNF-07 | Segurança | Nenhuma elevação de privilégio; OWASP ASVS nível 2 como referência; imagem assinada e SBOM |
| RNF-08 | Acessibilidade | WCAG 2.1 AA |
| RNF-09 | Usabilidade | Interface responsiva (desktop prioritário, tablet funcional) |
| RNF-10 | Disponibilidade | Suporte a múltiplas réplicas com PostgreSQL |
| RNF-11 | Observabilidade | A console expõe `/metrics` (Prometheus) e logs estruturados |
| RNF-12 | Licença | Apache-2.0; dependências com licenças compatíveis verificadas no CI |
| RNF-13 | Funcionamento offline | Sem chamadas a serviços externos (adequado a ambientes isolados/air-gapped) |
