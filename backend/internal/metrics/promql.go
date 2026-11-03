package metrics

import (
	"context"
	"fmt"
	"math"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/fbicudo/kubeviz/backend/internal/store"
)

// Consultas PromQL equivalentes às séries do coletor embutido. Precisam de:
//   - cAdvisor (do kubelet): uso de CPU e memória dos contêineres;
//   - kube-state-metrics v2: requests, limits, capacidade, donos dos pods.
//
// Unidades como no coletor: CPU em milicores, memória em bytes.

// promBackend é um Prometheus em uso para o histórico.
type promBackend struct {
	c *promClient
	// nodeCgroup: o cAdvisor expõe o cgroup raiz de cada nó com o nome do nó
	// (rótulo node ou kubernetes_io_hostname), que inclui o sistema, como o
	// metrics-server. Sem ele, o uso do nó é a soma dos pods.
	nodeCgroup bool
}

func q(s string) string { return strconv.Quote(s) }

// Uso do cgroup raiz de cada nó, com o rótulo "node".
func nodeUsageExpr(metric, fn, w string) string {
	return fmt.Sprintf(`max by (node) (label_replace(%s(%s{id="/"}[%s]), "node", "$1", "kubernetes_io_hostname", "(.+)"))`, fn, metric, w)
}

// Probe confere se o Prometheus tem o que as consultas usam. missing lista
// o que falta; err é um Prometheus inacessível.
func (b *promBackend) probe(ctx context.Context) (missing []string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, ok, err := b.c.query(ctx, `count(container_cpu_usage_seconds_total{container!="", pod!=""})`); err != nil {
		return nil, err
	} else if !ok {
		missing = append(missing, "cadvisor")
	}
	if _, ok, err := b.c.query(ctx, `count(kube_pod_owner) and count(kube_pod_container_resource_requests) and count(kube_node_status_allocatable)`); err != nil {
		return nil, err
	} else if !ok {
		missing = append(missing, "kube-state-metrics")
	}
	if len(missing) == 0 {
		n, ok, err := b.c.query(ctx, `count(`+nodeUsageExpr("container_cpu_usage_seconds_total", "rate", "5m")+` * on (node) group_left () max by (node) (kube_node_info))`)
		if err != nil {
			return nil, err
		}
		b.nodeCgroup = ok && n > 0
	}
	return missing, nil
}

// Passo dos gráficos por período: de 60 a 360 pontos.
func promStep(span time.Duration) time.Duration {
	switch {
	case span <= 15*time.Minute:
		return 15 * time.Second
	case span <= time.Hour:
		return 30 * time.Second
	case span <= 6*time.Hour:
		return 2 * time.Minute
	case span <= 24*time.Hour:
		return 5 * time.Minute
	case span <= 7*24*time.Hour:
		return 30 * time.Minute
	}
	return 2 * time.Hour
}

// promWindow: a janela de rate/avg_over_time cobre o passo inteiro (médias,
// como no coletor) e ao menos 2 min (duas coletas com o intervalo de 1 min).
func promWindow(step time.Duration) string {
	if step < 2*time.Minute {
		step = 2 * time.Minute
	}
	return strconv.Itoa(int(step.Seconds())) + "s"
}

// promQueries monta as 8 consultas na ordem de store.Sample: uso, requests,
// limits e capacidade, de CPU e de memória. "" = não se aplica (zero).
func promQueries(key store.SeriesKey, w string, nodeCgroup bool) [8]string {
	// m: filtro nos seletores; filter: pods do escopo (namespace, pod).
	var m, filter string
	switch key.Kind {
	case "namespace":
		m = ", namespace=" + q(key.Name)
	case "node":
		filter = fmt.Sprintf(`max by (namespace, pod) (kube_pod_info{node=%s})`, q(key.Name))
	case "pod":
		m = ", namespace=" + q(key.Namespace) + ", pod=" + q(key.Name)
	case "workload":
		ns := "namespace=" + q(key.Namespace)
		m = ", " + ns
		switch key.OwnerKind {
		case "Pod":
			m += ", pod=" + q(key.Name)
		case "Deployment":
			filter = fmt.Sprintf(`max by (namespace, pod) (label_replace(kube_pod_owner{%s, owner_kind="ReplicaSet"}, "replicaset", "$1", "owner_name", "(.+)")`+
				` * on (namespace, replicaset) group_left () max by (namespace, replicaset) (kube_replicaset_owner{%s, owner_kind="Deployment", owner_name=%s}))`,
				ns, ns, q(key.Name))
		default:
			filter = fmt.Sprintf(`max by (namespace, pod) (kube_pod_owner{%s, owner_kind=%s, owner_name=%s})`, ns, q(key.OwnerKind), q(key.Name))
		}
	}
	scoped := func(expr string) string {
		if filter != "" {
			expr = "(" + expr + ") * on (namespace, pod) group_left () " + filter
		}
		return "sum(" + expr + ")"
	}
	containers := `container!="", container!="POD", pod!=""` + m
	usage := func(metric, fn string) string {
		return scoped(fmt.Sprintf(`max by (namespace, pod, container) (%s(%s{%s}[%s]))`, fn, metric, containers, w))
	}
	// Pods terminados não reservam recursos (como no coletor).
	active := fmt.Sprintf(`max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"%s} == 1)`, m)
	resources := func(metric, resource string) string {
		return scoped(fmt.Sprintf(`max by (namespace, pod, container) (%s{resource=%s%s}) * on (namespace, pod) group_left () %s`, metric, q(resource), m, active))
	}
	milli := func(expr string) string { return "1000 * " + expr }

	out := [8]string{
		milli(usage("container_cpu_usage_seconds_total", "rate")),
		usage("container_memory_working_set_bytes", "avg_over_time"),
		milli(resources("kube_pod_container_resource_requests", "cpu")),
		resources("kube_pod_container_resource_requests", "memory"),
		milli(resources("kube_pod_container_resource_limits", "cpu")),
		resources("kube_pod_container_resource_limits", "memory"),
	}
	if key.Kind == "cluster" || key.Kind == "node" {
		nodes := "max by (node) (kube_node_info)"
		nm := ""
		if key.Kind == "node" {
			nodes = fmt.Sprintf("max by (node) (kube_node_info{node=%s})", q(key.Name))
			nm = ", node=" + q(key.Name)
		}
		if nodeCgroup {
			// Uso do nó inteiro (inclui o sistema), como o metrics-server.
			out[0] = milli(fmt.Sprintf("sum(%s * on (node) group_left () %s)", nodeUsageExpr("container_cpu_usage_seconds_total", "rate", w), nodes))
			out[1] = fmt.Sprintf("sum(%s * on (node) group_left () %s)", nodeUsageExpr("container_memory_working_set_bytes", "avg_over_time", w), nodes)
		}
		out[6] = milli(fmt.Sprintf(`sum(max by (node) (kube_node_status_allocatable{resource="cpu"%s}))`, nm))
		out[7] = fmt.Sprintf(`sum(max by (node) (kube_node_status_allocatable{resource="memory"%s}))`, nm)
	}
	return out
}

// history consulta o período no Prometheus.
func (b *promBackend) history(ctx context.Context, key store.SeriesKey, span time.Duration) (store.Tier, []store.Point, error) {
	step := promStep(span)
	end := time.Now().Truncate(step)
	start := end.Add(-span)
	queries := promQueries(key, promWindow(step), b.nodeCgroup)

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var (
		wg      sync.WaitGroup
		results [8][]promSeries
		errs    [8]error
	)
	for i, expr := range queries {
		if expr == "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = b.c.queryRange(ctx, expr, start, end, step)
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return store.Tier{}, nil, err
		}
	}

	// Por instante: a soma de cada consulta e quais delas responderam.
	type row struct {
		v   [8]float64
		has [8]bool
	}
	byTS := map[int64]*row{}
	for i, res := range results {
		for _, s := range res {
			for _, v := range s.Values {
				if math.IsNaN(v.V) || math.IsInf(v.V, 0) {
					continue
				}
				ts := int64(v.T)
				r := byTS[ts]
				if r == nil {
					r = &row{}
					byTS[ts] = r
				}
				r.v[i] += v.V
				r.has[i] = true
			}
		}
	}
	stamps := make([]int64, 0, len(byTS))
	for ts := range byTS {
		stamps = append(stamps, ts)
	}
	slices.Sort(stamps)

	// Requests, limits e capacidade (kube-state-metrics) mudam pouco: se uma
	// coleta falhou num instante em que o uso existe, vale o último valor
	// visto há até 5 min (ou 3 passos), em vez de uma queda falsa a zero.
	hold := int64(max(5*time.Minute, 3*step) / time.Second)
	var last [8]float64
	var lastAt [8]int64
	points := make([]store.Point, 0, len(stamps))
	for _, ts := range stamps {
		r := byTS[ts]
		for i := 2; i < 8; i++ {
			if r.has[i] {
				last[i], lastAt[i] = r.v[i], ts
			} else if lastAt[i] != 0 && ts-lastAt[i] <= hold {
				r.v[i] = last[i]
			}
		}
		// Sem uso medido, o instante fica de fora (lacuna no gráfico).
		if !r.has[0] && !r.has[1] {
			continue
		}
		v := r.v
		points = append(points, store.Point{TS: ts, Sample: store.Sample{
			CPU: v[0], Mem: v[1], CPUReq: v[2], MemReq: v[3], CPULim: v[4], MemLim: v[5], CPUCap: v[6], MemCap: v[7],
		}})
	}
	return store.Tier{Step: step}, points, nil
}
