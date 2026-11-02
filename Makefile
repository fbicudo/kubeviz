# Kubora — tarefas de desenvolvimento.
# Requer: Go, Node.js LTS e pnpm. Rode `make help` para a lista.

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

PKG     := kubora.dev/kubora/internal/version
LDFLAGS := -s -w -X $(PKG).Version=$(VERSION) -X $(PKG).Commit=$(COMMIT) -X $(PKG).Date=$(DATE)
WEBDIST := backend/internal/web/dist

.PHONY: help deps dev-backend dev-frontend frontend build test test-integration kind-up kind-down lint clean

help: ## Mostra esta ajuda
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

deps: ## Instala as dependências do frontend e baixa os módulos Go
	cd frontend && pnpm install --frozen-lockfile
	cd backend && go mod download

dev-backend: ## Roda a API em http://127.0.0.1:4466
	cd backend && go run ./cmd/kubora --log-level debug

dev-frontend: ## Roda a UI com recarga automática em http://localhost:5173
	cd frontend && pnpm dev

frontend: ## Compila a UI e copia para dentro do backend (go:embed)
	cd frontend && pnpm build
	find $(WEBDIST) -mindepth 1 ! -name .gitkeep -delete
	cp -r frontend/dist/. $(WEBDIST)/

build: frontend ## Gera o binário único bin/kubora com a UI embutida
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o ../bin/kubora ./cmd/kubora

test: ## Roda os testes do backend e do frontend
	cd backend && go test ./...
	cd frontend && pnpm test

test-integration: ## Testa contra o cluster do kubeconfig atual (ex.: kind)
	cd backend && go test -tags integration -count=1 -v ./internal/cluster/ -run Integration

kind-up: ## Cria o cluster de desenvolvimento kind-kubora-dev
	kind create cluster --name kubora-dev --wait 120s

kind-down: ## Remove o cluster de desenvolvimento
	kind delete cluster --name kubora-dev

lint: ## Verifica formatação, go vet, tipos e lint do frontend
	@test -z "$$(gofmt -l backend)" || (echo "arquivos sem gofmt:"; gofmt -l backend; exit 1)
	cd backend && go vet ./...
	cd frontend && pnpm typecheck && pnpm lint

clean: ## Remove artefatos de build
	rm -rf bin frontend/dist
	find $(WEBDIST) -mindepth 1 ! -name .gitkeep -delete
