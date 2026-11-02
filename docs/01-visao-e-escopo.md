# 1. Visão e escopo

## 1.1 Problema

Gerenciar Kubernetes exige domínio de `kubectl`, YAML e de dezenas de tipos de
recurso. As interfaces gráficas existentes caem em dois extremos:

- **Navegadores de recursos** (Headlamp, o antigo Kubernetes Dashboard, Freelens):
  mostram o que existe no cluster, mas ajudam pouco a *configurar* corretamente e
  oferecem métricas básicas ou dependentes de plugins.
- **Plataformas completas** (Rancher, Portainer Business, KubeSphere): poderosas,
  mas pesadas de instalar e operar, com curva de aprendizado alta ou recursos
  importantes em edições pagas.

## 1.2 Visão

> Uma console web leve, open source e instalável com um único comando, que permita
> **ver a saúde** do cluster (performance e uptime) e **configurá-lo com
> segurança** por meio de assistentes guiados, sem exigir que o usuário escreva
> YAML, mas sem esconder o YAML de quem quer vê-lo.

## 1.3 Princípios do produto

1. **Fácil de instalar:** `helm install` ou um único `docker run`/binário local.
   Sem banco de dados externo obrigatório.
2. **Seguro por padrão:** a console nunca tem mais permissão que o usuário logado;
   respeita o RBAC do cluster.
3. **Transparente:** todo assistente mostra o YAML gerado, o *diff* contra o estado
   atual e o resultado de um *dry-run* antes de aplicar.
4. **Rápida:** dados em tempo real (watch), navegação instantânea mesmo em clusters
   com milhares de pods.
5. **Profissional:** visual de painel de observabilidade (referência:
   Grafana/Datadog), denso em informação, tema escuro como padrão e tema claro
   disponível, acessível (WCAG 2.1 AA).
6. **Comunitário:** desenvolvido em aberto, com roadmap público e fácil de
   contribuir.

## 1.4 Público-alvo (personas — a validar)

| Persona | Necessidade principal |
|---------|-----------------------|
| **Operador / SRE** | Visão geral da saúde, uptime, consumo de recursos, eventos, troubleshooting rápido |
| **Desenvolvedor** | Fazer deploy da própria aplicação, ver logs, reiniciar, escalar, sem dominar todo o Kubernetes |
| **Administrador de plataforma** | Criar namespaces, quotas, RBAC, políticas de rede, padronizar configurações |

## 1.5 Escopo do MVP (proposta)

**Dentro:**

- Visão geral do cluster (nós, workloads, capacidade, alertas de saúde)
- Navegação e edição de todos os recursos (incluindo CRDs), com editor YAML
- Logs em tempo real, terminal (`exec`) no container, eventos
- Gráficos de performance: CPU, memória, rede e disco por cluster, nó, namespace e
  workload, com histórico
- Uptime/disponibilidade por workload e por nó, com histórico e SLA (%), combinando
  o estado do Kubernetes com sondas sintéticas HTTP/TCP
- Assistentes: Deploy de aplicação, Exposição (Service + Ingress/Gateway),
  Autoscaling (HPA), Armazenamento (PVC), Namespace com quotas, RBAC
  (usuário/grupo → permissões), Política de rede (NetworkPolicy) e Verificação de
  boas práticas do cluster
- Métricas via Prometheus quando disponível, com coletor embutido como alternativa
- Um cluster por instalação (no modo local, troca de contexto do kubeconfig)
- Autenticação OIDC (prioritária) e por token; autorização via RBAC do cluster
- Instalação via Helm chart e execução local com kubeconfig
- Interface em português (pt-BR) e inglês

**Fora do MVP (candidatos a fases futuras):**

- Gestão de múltiplos clusters em uma única instalação (decidido: pós-MVP)
- Criação/provisionamento de clusters (EKS/AKS/GKE)
- Alertas com notificação (e-mail, Slack, Teams) — decidido: pós-1.0
- Integração GitOps (Argo CD / Flux)
- Assistente com IA — decidido: pós-1.0
- Suporte oficial a OpenShift
- Catálogo de aplicações (Helm charts)
- Análise de custos

## 1.6 Critérios de sucesso do MVP (proposta)

- Instalação funcional em menos de 5 minutos em kind, minikube, k3s, kubeadm,
  RKE2, EKS, AKS e GKE
- Um desenvolvedor sem experiência em YAML consegue publicar e expor uma aplicação
  pelo assistente em menos de 10 minutos
- Lista de 5.000 pods renderizada e filtrável em menos de 1 segundo
- Zero ações executadas fora das permissões RBAC do usuário (verificado em testes)
