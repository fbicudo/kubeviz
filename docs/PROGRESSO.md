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
- **Não verificado:** aparência no navegador (sem navegador nesta máquina; ver
  bloqueios); CI no GitHub (repositório ainda não publicado); `make` (não
  instalado; os comandos equivalentes foram executados manualmente).

## Próximas tarefas (Fase 0)

1. **0.2 — Conexão com o cluster:** `client-go`, modo local (kubeconfig e troca
   de contexto) e in-cluster; endpoint de informações do cluster; testes com
   `envtest`.
2. **0.3 — Autenticação por token e proxy autenticado:** login com token bearer,
   sessão em cookie `HttpOnly`, proxy `/api/k8s/*` com a identidade do usuário
   (impersonation no modo in-cluster), proteção CSRF; tela de login.
3. **0.4 — Primeira lista real:** pods do namespace, respeitando o RBAC do
   usuário (critério de pronto da Fase 0).
4. **0.5 — Empacotamento:** Dockerfile (distroless, multi-arquitetura) e Helm
   chart com ServiceAccount de permissões mínimas.
5. **0.6 — Revisão visual:** conferir as telas no navegador, ajustar tokens de
   cor e densidade, definir logo e paleta finais.
6. **0.7 — Publicação:** criar o repositório no GitHub, confirmar o CI verde,
   ativar o relato privado de vulnerabilidades.

## Bloqueios e pendências do responsável

| Item | Por quê | Como resolver |
|------|---------|---------------|
| Docker + kind | Necessário para testar o Helm chart e o critério de pronto da Fase 0 | `sudo apt install docker.io` e `sudo usermod -aG docker $USER` |
| `make` | Executar as tarefas do `Makefile` | `sudo apt install make` |
| Bibliotecas do Chromium | Capturas de tela automáticas da UI | `sudo npx playwright install-deps chromium` |
| Contato do Código de Conduta | `CODE_OF_CONDUCT.md` tem um campo `<contato-a-definir>` | Definir um e-mail ou canal público do projeto |
| Usuário do GitHub | `MAINTAINERS.md` e caminhos do chart | Informar o usuário |
| Domínio `kubora.dev` | O módulo Go usa `kubora.dev/kubora` | Registrar o domínio, ou trocar o caminho do módulo |

## Ambiente de desenvolvimento desta máquina

Ferramentas instaladas sem `sudo`, em `~/.local` (PATH configurado em
`~/.profile`): Go 1.27.3, Node.js 26.13 LTS, pnpm 12.16, kubectl 1.37, Helm 4.3,
kind 0.33.
