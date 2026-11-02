#!/usr/bin/env bash
# Cenário de carga para o KubeViz: nós e pods simulados pelo kwok
# (https://kwok.sigs.k8s.io) no cluster kind de desenvolvimento. Os pods
# existem na API, com status e eventos, mas nenhum container roda.
#
# Uso: hack/scale/kwok.sh up [pods]   (padrão: 5000; namespace "carga")
#      hack/scale/kwok.sh down
set -euo pipefail

KWOK_VERSION="v0.8.0"
CONTEXT="${CONTEXT:-kind-kubeviz-dev}"
k() { kubectl --context "$CONTEXT" "$@"; }

if [[ "${1:-up}" == down ]]; then
  k delete namespace carga --ignore-not-found --wait=false
  k delete nodes -l type=kwok --ignore-not-found > /dev/null
  echo "Cenário de carga removido (o kwok continua instalado em kube-system)."
  exit 0
fi

pods="${2:-5000}"
per_node=110
nodes=$(( (pods + per_node - 1) / per_node + 1 ))
per_deploy=500
deploys=$(( (pods + per_deploy - 1) / per_deploy ))

base="https://github.com/kubernetes-sigs/kwok/releases/download/$KWOK_VERSION"
k apply -f "$base/kwok.yaml" > /dev/null
k wait --for=condition=Established crd/stages.kwok.x-k8s.io --timeout=60s > /dev/null
k apply -f "$base/stage-fast.yaml" > /dev/null
k -n kube-system rollout status deployment/kwok-controller --timeout=180s > /dev/null

for i in $(seq 0 $((nodes - 1))); do
  cat <<NODE
---
apiVersion: v1
kind: Node
metadata:
  name: kwok-node-$i
  annotations:
    node.alpha.kubernetes.io/ttl: "0"
    kwok.x-k8s.io/node: fake
  labels:
    kubernetes.io/hostname: kwok-node-$i
    kubernetes.io/os: linux
    kubernetes.io/arch: amd64
    node-role.kubernetes.io/agent: ""
    type: kwok
spec:
  taints:
    - {key: kwok.x-k8s.io/node, value: fake, effect: NoSchedule}
status:
  allocatable: {cpu: "32", memory: 256Gi, pods: "$per_node"}
  capacity: {cpu: "32", memory: 256Gi, pods: "$per_node"}
NODE
done | k apply -f - > /dev/null

k create namespace carga --dry-run=client -o yaml | k apply -f - > /dev/null
remaining=$pods
for i in $(seq 1 "$deploys"); do
  n=$(( remaining < per_deploy ? remaining : per_deploy ))
  remaining=$(( remaining - n ))
  cat <<DEPLOY
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: app-$i, namespace: carga}
spec:
  replicas: $n
  selector: {matchLabels: {app: app-$i}}
  template:
    metadata: {labels: {app: app-$i}}
    spec:
      nodeSelector: {type: kwok}
      tolerations: [{key: kwok.x-k8s.io/node, operator: Exists, effect: NoSchedule}]
      containers: [{name: app, image: registry.example/app:$i}]
DEPLOY
done | k apply -f - > /dev/null

echo "Criando $pods pods em $nodes nós simulados; acompanhe com:"
echo "  kubectl --context $CONTEXT -n carga get pods --no-headers | grep -c Running"
