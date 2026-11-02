# 5. Roadmap

Esforço em semanas de trabalho equivalentes a tempo integral, para um
desenvolvedor com assistência do Claude (ver
[viabilidade](02-viabilidade.md#25-estimativa-de-esforço)): total de ~29 a 37
semanas. Cada fase termina com uma versão utilizável publicada.

**Forma de trabalho (dedicação variável):**

- O trabalho é dividido em tarefas pequenas e independentes (algumas horas cada),
  registradas como issues no GitHub.
- Cada tarefa termina com código testado e commitado, para que o projeto possa ser
  pausado e retomado em qualquer ponto sem perder contexto.
- Um arquivo `docs/PROGRESSO.md` registra o que foi feito, decisões recentes e a
  próxima tarefa, servindo de ponto de partida para cada nova sessão de trabalho.

## Fase 0 — Fundação (4–5 semanas) → `v0.1`
- Monorepo, CI (lint, testes, build multi-arquitetura), convenções de contribuição
- Governança: LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, DCO, roadmap público
- Design system: tokens de cor/tipografia, componentes base, tema claro/escuro,
  protótipo navegável das telas principais (validação visual antes de implementar)
- Backend: servidor HTTP, autenticação (token + kubeconfig local), proxy autenticado
- Frontend: layout (menu lateral, cabeçalho, busca global), login, i18n
- Helm chart inicial
- **Pronto quando:** instala via Helm em kind e lista pods com o RBAC do usuário

## Fase 1 — Navegação e operação (7–9 semanas) → `v0.2`
- Listas e detalhes de todos os recursos (genérico via discovery + telas
  específicas para os principais)
- Tempo real via WebSocket, editor YAML com validação e diff
- Logs, exec, eventos, ações (escalar, reiniciar, rollback, excluir)
- OIDC
- **Pronto quando:** cobre o dia a dia que hoje se faz com `kubectl get/describe/
  logs/exec/edit`

## Fase 2 — Performance e uptime (6–8 semanas) → `v0.3`
- Detecção de fontes de métricas; integração Prometheus; coletor embutido
- Painéis por cluster/nó/namespace/workload; seletor de período
- Motor de uptime, histórico, linha do tempo, % de disponibilidade
- Sondas sintéticas HTTP/TCP
- **Pronto quando:** responde "o que está consumindo recursos?" e "qual foi a
  disponibilidade do serviço X no último mês?" sem Grafana

## Fase 3 — Assistentes (8–10 semanas) → `v0.4`
- Motor de assistentes declarativos (passos, validação, templates, dry-run, diff)
- Publicar e expor aplicação; autoscaling (HPA) e armazenamento (PVC)
- Namespace com quotas/LimitRange e RBAC
- Política de rede com editor visual e verificação de boas práticas do cluster
- **Pronto quando:** usuário publica e expõe uma aplicação com HTTPS sem escrever YAML

## Fase 4 — Endurecimento (4–5 semanas) → `v1.0`
- Revisão de segurança e testes de RBAC, testes de carga (10k pods)
- Auditoria, acessibilidade, documentação de usuário (pt-BR/en), site do projeto
- Imagem assinada, SBOM, política de versões e de segurança
- **Pronto quando:** critérios de sucesso do [doc 1](01-visao-e-escopo.md#16-critérios-de-sucesso-do-mvp-proposta) atendidos

## Pós-1.0 (candidatos)
Multi-cluster · alertas e notificações · assistente com IA · topologia · GitOps
(Argo CD/Flux) · catálogo Helm · custos (OpenCost) · página de status pública ·
suporte oficial a OpenShift.
