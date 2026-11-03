# Métricas e histórico

O KubeViz mostra o uso de CPU e memória **agora** (metrics-server) e **ao
longo do tempo**, além de indicadores de saúde do cluster. O histórico vem do
Prometheus do cluster, quando há um, ou do coletor embutido, sem precisar
instalar nada.

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

## Saúde (Visão geral)

O painel **Saúde** da Visão geral aponta o que costuma estar por trás de um
problema:

| Indicador | O que conta |
|---|---|
| Reinícios | Pods com container reiniciado na última hora ou em CrashLoopBackOff |
| Sem memória (OOM) | Containers mortos por estourar o limit de memória (OOMKilled) nas últimas 24 h |
| Pods pendentes | Pods em Pending há mais de 2 min: sem nó que comporte (Unschedulable) ou sem conseguir iniciar (ImagePullBackOff…) |
| Nós fora do ar | Nós com a condição Ready diferente de True |

Clicar num indicador filtra a lista, que traz o motivo, a mensagem do
Kubernetes e um link para o objeto. Os dados vêm do estado atual dos pods e
nós, lidos com a credencial de quem vê: cada pessoa vê só o que pode listar.

![Saúde na Visão geral](img/saude.png)

## Aba Métricas no detalhe

Pods, nós, Deployments, StatefulSets, DaemonSets e Jobs têm uma aba
**Métricas**:

- **Pod:**
  - uso agora de cada container, sobre o limit (o traço marca o request);
  - o histórico do pod, que **requer o Prometheus**, porque o coletor
    embutido não guarda pods individuais;
  - um link para o histórico do workload.
- **Workload:** o histórico do workload e os pods dele agora.
- **Nó:** uso agora sobre o alocável, o histórico do nó e os pods agendados
  nele.

![Aba Métricas de um pod](img/detalhe-pod-metricas.png)

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
| `--prometheus` / `KUBEVIZ_PROMETHEUS` | `auto` | `auto` (procura um Service), `off` ou o endereço do Prometheus |

No Helm, use `metrics.collector.*`, `metrics.prometheus` e `persistence.*`. Sem `persistence.enabled`,
o banco fica num `emptyDir` e o histórico recomeça quando o pod é recriado:

```yaml
persistence:
  enabled: true
  size: 1Gi
```

![Histórico de um workload](img/historico-workload.png)

## Histórico pelo Prometheus

Se o cluster já tem um Prometheus, o KubeViz o encontra sozinho e passa a
buscar o histórico nele, com as mesmas séries e gráficos. Vantagens:

- o histórico já existe desde antes de instalar o KubeViz, pelo tempo de
  retenção do Prometheus;
- o coletor embutido fica **pausado** enquanto o Prometheus responde, e não
  gasta memória com o mesmo trabalho. Se o Prometheus parar de responder, o
  coletor volta em até 1 minuto; quando o Prometheus volta, o KubeViz o retoma
  em até 5 minutos.

O painel Histórico mostra a fonte em uso ("Fonte: Prometheus
(monitoring/prometheus-server)" ou "Fonte: coletor embutido").

![Histórico pelo Prometheus](img/historico-prometheus.png)

**Requisitos:** o Prometheus precisa coletar:

- o **cAdvisor** do kubelet (uso de CPU e memória dos contêineres);
- o **kube-state-metrics** v2 (requests, limits, capacidade e donos dos pods).

O kube-prometheus-stack e o chart `prometheus-community/prometheus` já trazem
os dois. Se faltar algum, o painel diz o que falta e o coletor continua.

**Como é encontrado** (`--prometheus=auto`, o padrão):

1. O KubeViz procura Services com "prometheus" no nome, ou com o rótulo
   `app.kubernetes.io/name=prometheus`, ignorando Alertmanager, Pushgateway,
   exporters e afins.
2. Testa os mais prováveis e usa o primeiro que tiver os dados.
3. Sem Prometheus, procura de novo a cada 5 minutos.

O acesso ao Service é feito assim:

- **no cluster:** direto pelo DNS do Service; a ServiceAccount recebe leitura
  de Services;
- **no modo local:** pelo proxy do API server, com a credencial do kubeconfig
  (`services/proxy`).

**Endereço fixo:** `--prometheus=http://prometheus.monitoring.svc:9090`. Serve
qualquer API compatível (Thanos, VictoriaMetrics). Para autenticação básica,
use `https://usuario:senha@host`; a senha não aparece na interface nem nos
logs. `--prometheus=off` desliga a integração.

**Diferenças em relação ao coletor:**

- **Uso de um nó:** quando o cAdvisor expõe o cgroup raiz com o nome do nó (o
  comum), é o uso do nó inteiro, como no metrics-server. Senão, é a soma dos
  pods.
- **Resolução:** de 15 s (período de 15 min) a 2 h (30 dias). Cada ponto é a
  média do intervalo.
- **Requests, limits e capacidade:** se uma coleta do kube-state-metrics
  falhar, vale o último valor visto há até 5 min, em vez de uma queda falsa a
  zero no gráfico.
- **Pods individuais:** só com o Prometheus (aba Métricas do pod).
- **Permissões:** as mesmas do coletor. Cada consulta é conferida com o RBAC
  de quem pergunta, e só as séries de cluster, nós, namespaces e workloads
  ficam acessíveis, nunca PromQL livre.

Para testar no kind: `hack/demo/prometheus.sh` instala um Prometheus mínimo
(servidor e kube-state-metrics).
