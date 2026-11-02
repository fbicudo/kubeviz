# Métricas e histórico

O KubeViz mostra o uso de CPU e memória **agora** (metrics-server) e **ao
longo do tempo** (coletor embutido), sem precisar de Prometheus ou Grafana.

![Página Métricas](img/metricas.png)

## Requisito: metrics-server

O uso vem da API `metrics.k8s.io`, oferecida pelo
[metrics-server](https://github.com/kubernetes-sigs/metrics-server). A maioria
dos clusters gerenciados (EKS, AKS, GKE, k3s) já o traz. Nos outros:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

No kind e no minikube, ele precisa de `--kubelet-insecure-tls`. Veja
`hack/demo/metrics-server.sh`, que serve só para desenvolvimento.

## Agora

A página **Métricas** e os blocos de CPU e memória da **Visão geral** leem o
metrics-server com a credencial de quem está logado, a cada 15 s:

- uso e reservas (requests) do cluster, sobre a capacidade alocável dos nós;
- nós;
- maiores consumidores, por workload ou por pod;
- namespaces.

## Histórico (coletor embutido)

O coletor amostra o cluster a cada 30 s e guarda a CPU e a memória (uso,
requests, limits e capacidade) do **cluster**, de cada **nó**, de cada
**namespace** e de cada **workload**. Pods individuais não são guardados: com
milhares de pods, seriam dezenas de milhões de linhas por dia.

| Período consultado | Resolução | Guardado por |
|---|---|---|
| até 24 h | amostras de 30 s | 24 h |
| até 7 dias | médias de 5 min | 7 dias |
| até 30 dias (ou a retenção configurada) | médias de 1 h | `--metrics-retention` (padrão 30 dias) |

- **Banco:** SQLite (Go puro, sem dependências), em
  `~/.config/kubeviz/data/kubeviz.db` no modo local ou `/var/lib/kubeviz` no
  cluster. Com 1 nó e cerca de 20 workloads, ocupa poucos MB por mês.
- **Lacunas:** períodos em que o coletor ficou parado aparecem como lacunas no
  gráfico, e não como uma linha reta.
- **Modo local:** o histórico é separado por contexto do kubeconfig.

**Permissões**

- O coletor usa a credencial do KubeViz: o kubeconfig no modo local, ou a
  ServiceAccount no cluster, que recebe só leitura de nós, pods e métricas.
- Cada consulta ao histórico é conferida com o RBAC de quem pergunta
  (`SelfSubjectAccessReview`):
  - **cluster e nós:** exigem poder listar nós;
  - **namespaces e workloads:** exigem poder listar pods naquele namespace.

  Quem não poderia ver os objetos também não vê as séries.

### Opções

| Flag / variável | Padrão | Descrição |
|---|---|---|
| `--metrics-collector` / `KUBEVIZ_METRICS_COLLECTOR` | `true` | Liga o coletor |
| `--metrics-interval` / `KUBEVIZ_METRICS_INTERVAL` | `30s` | Intervalo entre amostras (mínimo 10 s) |
| `--metrics-retention` / `KUBEVIZ_METRICS_RETENTION` | `720h` | Por quanto tempo guardar (mínimo 168 h) |
| `--data-dir` / `KUBEVIZ_DATA_DIR` | ver acima | Diretório do banco |

No Helm, use `metrics.collector.*` e `persistence.*`. Sem `persistence.enabled`,
o banco fica num `emptyDir` e o histórico recomeça quando o pod é recriado:

```yaml
persistence:
  enabled: true
  size: 1Gi
```

![Histórico de um workload](img/historico-workload.png)
