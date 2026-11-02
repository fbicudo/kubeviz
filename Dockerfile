# syntax=docker/dockerfile:1
# Imagem do KubeViz: binário único (API + interface) sobre distroless.
# Build:  make image          Multi-arquitetura: docker buildx --platform linux/amd64,linux/arm64

# 1) Interface (independe da arquitetura de destino)
FROM --platform=$BUILDPLATFORM node:26-alpine AS ui
WORKDIR /src/frontend
RUN npm install -g pnpm@12.16.1 --silent
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# 2) Backend, compilado de forma cruzada para a arquitetura de destino
FROM --platform=$BUILDPLATFORM golang:1.27 AS build
ARG TARGETOS TARGETARCH
ARG VERSION=dev COMMIT=none DATE=unknown
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
COPY --from=ui /src/frontend/dist/ ./internal/web/dist/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
      -ldflags "-s -w \
        -X github.com/fbicudo/kubeviz/backend/internal/version.Version=${VERSION} \
        -X github.com/fbicudo/kubeviz/backend/internal/version.Commit=${COMMIT} \
        -X github.com/fbicudo/kubeviz/backend/internal/version.Date=${DATE}" \
      -o /out/kubeviz ./cmd/kubeviz

# 3) Execução: sem shell, sem gerenciador de pacotes, usuário não-root
FROM gcr.io/distroless/static-debian13:nonroot
LABEL org.opencontainers.image.title="KubeViz" \
      org.opencontainers.image.description="Console web para gestão de clusters Kubernetes" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/fbicudo/kubeviz"
COPY --from=build /out/kubeviz /kubeviz
# Dentro do container o endereço precisa aceitar conexões de fora do pod.
ENV KUBEVIZ_LISTEN=0.0.0.0:4466
EXPOSE 4466
USER 65532:65532
ENTRYPOINT ["/kubeviz"]
