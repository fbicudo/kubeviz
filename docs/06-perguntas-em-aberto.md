# 6. Decisões e perguntas em aberto

## 6.1 Decisões tomadas (02/11/2026)

| # | Tema | Decisão | Impacto na documentação |
|---|------|---------|-------------------------|
| P1 | Estratégia | **Produto próprio**, do zero. Plugins e fork do Headlamp descartados | [Viabilidade §2.1](02-viabilidade.md#21-panorama-de-mercado-nov2026) |
| P2 | Clusters | **Um cluster por instalação no MVP**; multi-cluster pós-1.0 | RF-06 = F |
| P3 | Objetivo | **Projeto de comunidade open source** | Governança e documentação de contribuição entram no MVP ([Arquitetura §3.9](03-arquitetura.md#39-governança-open-source)) |
| P4 | Equipe | **Um desenvolvedor com assistência do Claude** | Estimativa recalculada ([Viabilidade §2.5](02-viabilidade.md#25-estimativa-de-esforço)) |
| P5 | Métricas | **Prometheus quando existir + coletor embutido** como alternativa | RF-33 |
| P6 | Uptime | **Estado do Kubernetes + sondas sintéticas** HTTP/TCP | RF-35 passa a M |
| P7 | Assistentes | **Oito assistentes no MVP:** publicar, expor, autoscaling, armazenamento, namespace/quotas, RBAC, política de rede, boas práticas. CronJob segue desejável | RF-40 a RF-46, RF-48 = M |
| P8 | Alertas | **Pós-1.0** | RF-38 = F |
| P9 | Assistente com IA | **Pós-1.0**; a arquitetura não deve impedir sua inclusão | Roadmap pós-1.0 |
| P10 | Login | **OIDC genérico** como prioridade, testado com Keycloak e Dex. Token e kubeconfig continuam como acesso alternativo e no modo local | RF-01 a RF-03 |
| P11 | Distribuições | **EKS, AKS, GKE, k3s, kind, minikube, kubeadm, RKE2.** OpenShift fora da 1.0 (melhor esforço) | RNF-03 |
| P12 | Escala | **Até ~5.000 pods** (~100 nós) | RNF-05, RNF-06 |
| P13 | Estilo visual | **Painel de observabilidade** (referência Grafana/Datadog): denso em informação, tema escuro como padrão | [Visão §1.3](01-visao-e-escopo.md#13-princípios-do-produto), [Arquitetura §3.2](03-arquitetura.md#frontend-typescript--react) |
| P14 | Idiomas | **pt-BR e inglês**, estrutura pronta para traduções da comunidade | RF-52 |
| P15 | Licença | **Apache-2.0** | ADR-007 |
| P16 | Repositório | **GitHub, conta pessoal**, com possibilidade de migrar para uma organização depois | [Arquitetura §3.9](03-arquitetura.md#39-governança-open-source) |
| P17 | Nome | **Kubora** (binário, imagem e Helm chart: `kubora`) | Toda a documentação |
| P18 | Dedicação | **Variável**, conforme a disponibilidade de tokens. Esforço medido em semanas de trabalho, não em datas | [Viabilidade §2.5](02-viabilidade.md#25-estimativa-de-esforço), [Roadmap](05-roadmap.md) |
| P19 | CNCF | **Talvez, decidir depois da 1.0.** Seguir desde já as práticas exigidas (governança, DCO, SECURITY.md) | [Arquitetura §3.9](03-arquitetura.md#39-governança-open-source) |

## 6.2 Verificação do nome "Kubora" (02/11/2026)

| Item | Situação |
|------|----------|
| Software/projeto Kubernetes com o mesmo nome | Nenhum encontrado (GitHub e web) |
| `github.com/Kubora` | **Ocupado** por uma conta pessoal pouco ativa (1 repositório). Repositório ficará em `github.com/<seu-usuário>/kubora`; para uma futura organização, usar `kubora-dev` ou similar |
| `kubora.com` | Registrado, estacionado para venda (Afternic) |
| `kubora.dev`, `kubora.io`, `kubora.org` | Sem DNS configurado, provavelmente livres. **Confirmar em um registrador** |
| Marca "Kubernetes" | A Linux Foundation não permite "Kubernetes" no nome de produtos; o prefixo "kube" é aceito |

Recomendação: registrar `kubora.dev` antes de publicar o repositório, para usar
como endereço estável da documentação e do Helm chart.

## 6.3 Pendências não bloqueantes

Podem ser resolvidas durante a Fase 0:

- **Logo e paleta de cores** do Kubora, dentro do estilo painel de observabilidade.
- **Registro do domínio** (ver 6.2).
- **Criação do repositório** no GitHub.
