#!/usr/bin/env bash
# Instala o metrics-server no cluster kind de desenvolvimento (fonte das
# métricas de CPU e memória do KubeViz). No kind, os certificados do kubelet
# não são assinados por uma CA conhecida: --kubelet-insecure-tls é só para
# desenvolvimento.
#
# Uso: hack/demo/metrics-server.sh
set -euo pipefail

VERSION="v0.9.0"
CONTEXT="${CONTEXT:-kind-kubeviz-dev}"
k() { kubectl --context "$CONTEXT" "$@"; }

k apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/$VERSION/components.yaml" > /dev/null
if ! k -n kube-system get deployment metrics-server -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q kubelet-insecure-tls; then
  k -n kube-system patch deployment metrics-server --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' > /dev/null
fi
k -n kube-system rollout status deployment/metrics-server --timeout=180s > /dev/null
k wait --for=condition=Available apiservice/v1beta1.metrics.k8s.io --timeout=120s > /dev/null
echo "metrics-server $VERSION pronto (kubectl top nodes)"
