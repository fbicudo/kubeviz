# Como contribuir com o Kubora

Obrigado pelo interesse! Contribuições de todos os tipos são bem-vindas: código,
documentação, traduções, testes, relatos de bugs e sugestões.

*Contributions in English are equally welcome.*

## Antes de começar

- Leia o [Código de Conduta](CODE_OF_CONDUCT.md).
- Para mudanças grandes, abra uma *issue* para discutir a ideia antes do PR.
- Vulnerabilidades de segurança **não** devem ser abertas como issue pública:
  siga o [SECURITY.md](SECURITY.md).

## Ambiente de desenvolvimento

Requisitos: Go (versão em `backend/go.mod`), Node.js LTS, pnpm e, para testes
com cluster, Docker + kind.

```bash
make dev-backend    # API em http://localhost:4466
make dev-frontend   # UI com recarga automática em http://localhost:5173
make test           # testes do backend e do frontend
make build          # binário único em bin/kubora (inclui a UI)
```

## Commits e DCO

Todo commit precisa da linha `Signed-off-by` (Developer Certificate of Origin),
que declara que você tem o direito de enviar a contribuição sob a licença
Apache-2.0. Use `git commit -s`.

Mensagens de commit seguem [Conventional Commits](https://www.conventionalcommits.org/pt-br/):
`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Pull requests

- Um assunto por PR; mantenha-os pequenos.
- Inclua testes para o comportamento novo ou corrigido.
- Textos de interface vão nos arquivos de tradução (`frontend/src/i18n/`), em
  pt-BR **e** inglês.
- O CI (lint, testes e build) precisa passar.

## Estrutura do repositório

Ver [docs/03-arquitetura.md](docs/03-arquitetura.md#37-estrutura-de-repositório-proposta).
