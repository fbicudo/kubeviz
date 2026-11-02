# KubeViz — tarefas de desenvolvimento.
# Requer: Go, Node.js LTS e pnpm. Rode `make help` para a lista.

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

PKG     := github.com/fbicudo/kubeviz/backend/internal/version
LDFLAGS := -s -w -X $(PKG).Version=$(VERSION) -X $(PKG).Commit=$(COMMIT) -X $(PKG).Date=$(DATE)
WEBDIST := backend/internal/web/dist

.PHONY: help deps dev-backend dev-frontend frontend build image helm-lint kind-install test test-integration test-envtest kind-up kind-down demo lint clean

help: ## Mostra esta ajuda
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

deps: ## Instala as dependências do frontend e baixa os módulos Go
	cd frontend && pnpm install --frozen-lockfile
	cd backend && go mod download

dev-backend: ## Roda a API em http://127.0.0.1:4466
	cd backend && go run ./cmd/kubeviz --log-level debug

dev-frontend: ## Roda a UI com recarga automática em http://localhost:5173
	cd frontend && pnpm dev

frontend: ## Compila a UI e copia para dentro do backend (go:embed)
	cd frontend && pnpm build
	find $(WEBDIST) -mindepth 1 ! -name .gitkeep -delete
	cp -r frontend/dist/. $(WEBDIST)/

build: frontend ## Gera o binário único bin/kubeviz com a UI embutida
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o ../bin/kubeviz ./cmd/kubeviz

IMAGE ?= kubeviz:dev

image: ## Gera a imagem de container $(IMAGE)
	docker build -t $(IMAGE) --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) --build-arg DATE=$(DATE) .

helm-lint: ## Valida o Helm chart
	helm lint deploy/helm/kubeviz
	helm template kubeviz deploy/helm/kubeviz > /dev/null

kind-install: image ## Instala o chart no kind com a imagem local (modo in-cluster, HTTPS)
	kind load docker-image $(IMAGE) --name kubeviz-dev
	helm upgrade --install kubeviz deploy/helm/kubeviz -n kubeviz --create-namespace \
		--set image.repository=docker.io/library/kubeviz --set image.tag=dev --set image.pullPolicy=Never --wait
	kubectl -n kubeviz rollout restart deploy/kubeviz

test: ## Roda os testes do backend e do frontend
	cd backend && go test ./...
	cd frontend && pnpm test

test-integration: ## Testa contra o cluster do kubeconfig atual (ex.: kind)
	cd backend && go test -tags integration -count=1 -v ./internal/cluster/ -run Integration

ENVTEST_K8S ?= 1.37.x

test-envtest: ## Testes de RBAC contra um API server real (envtest, sem Docker)
	go install sigs.k8s.io/controller-runtime/tools/setup-envtest@release-0.25
	cd backend && KUBEBUILDER_ASSETS="$$($$(go env GOPATH)/bin/setup-envtest use $(ENVTEST_K8S) -p path)" \
		go test -tags envtest -count=1 -v ./internal/server/ -run RBAC

kind-up: ## Cria o cluster de desenvolvimento kind-kubeviz-dev
	kind create cluster --name kubeviz-dev --wait 120s

kind-down: ## Remove o cluster de desenvolvimento
	kind delete cluster --name kubeviz-dev

demo: ## Aplica o cenário de demonstração no kind e gera ~/.kube/kubeviz-demo.yaml
	kubectl --context kind-kubeviz-dev apply -f hack/demo/demo.yaml
	hack/demo/kubeconfig.sh

lint: ## Verifica formatação, go vet, tipos e lint do frontend
	@test -z "$$(gofmt -l backend)" || (echo "arquivos sem gofmt:"; gofmt -l backend; exit 1)
	cd backend && go vet ./...
	cd frontend && pnpm typecheck && pnpm lint

clean: ## Remove artefatos de build
	rm -rf bin frontend/dist
	find $(WEBDIST) -mindepth 1 ! -name .gitkeep -delete
