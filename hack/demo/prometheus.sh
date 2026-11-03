#!/usr/bin/env bash
# Instala um Prometheus mínimo (servidor + kube-state-metrics) no cluster
# atual, para testar o histórico pelo Prometheus. Só para desenvolvimento:
# sem persistência, sem Alertmanager, retenção de 2 dias.
set -euo pipefail

ns=${PROMETHEUS_NAMESPACE:-monitoring}
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update prometheus-community >/dev/null
helm upgrade --install prometheus prometheus-community/prometheus \
  --namespace "$ns" --create-namespace \
  --set alertmanager.enabled=false \
  --set prometheus-pushgateway.enabled=false \
  --set prometheus-node-exporter.enabled=false \
  --set server.persistentVolume.enabled=false \
  --set server.retention=2d \
  --set server.global.scrape_interval=30s \
  --set server.resources.requests.memory=128Mi \
  --wait --timeout 5m
echo "Prometheus em $ns/prometheus-server. Remover: helm uninstall prometheus -n $ns"
