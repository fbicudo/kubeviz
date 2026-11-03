package metrics

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/store"
)

func svc(ns, name string, labels map[string]string, headless bool, ports ...corev1.ServicePort) *corev1.Service {
	s := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: labels}, Spec: corev1.ServiceSpec{Ports: ports, ClusterIP: "10.0.0.1"}}
	if headless {
		s.Spec.ClusterIP = corev1.ClusterIPNone
	}
	return s
}

func TestDiscoverPrometheus(t *testing.T) {
	web := corev1.ServicePort{Name: "http-web", Port: 9090}
	cs := fake.NewClientset(
		// kube-prometheus-stack
		svc("monitoring", "kps-kube-prometheus-stack-prometheus", map[string]string{"app": "kube-prometheus-stack-prometheus"}, false, web, corev1.ServicePort{Name: "reloader-web", Port: 8080}),
		svc("monitoring", "prometheus-operated", map[string]string{"operated-prometheus": "true"}, true, corev1.ServicePort{Name: "web", Port: 9090}),
		svc("monitoring", "kps-kube-prometheus-stack-alertmanager", nil, false, corev1.ServicePort{Name: "http-web", Port: 9093}),
		svc("kube-system", "kps-kube-prometheus-stack-kubelet", nil, true, corev1.ServicePort{Name: "https-metrics", Port: 10250}),
		svc("monitoring", "kps-kube-state-metrics", nil, false, corev1.ServicePort{Name: "http", Port: 8080}),
		// prometheus-community/prometheus
		svc("metrics", "prometheus-server", map[string]string{"app.kubernetes.io/name": "prometheus", "app.kubernetes.io/component": "server"}, false,
			corev1.ServicePort{Name: "http", Port: 80, TargetPort: intstr.FromInt32(9090)}),
		svc("metrics", "prometheus-prometheus-pushgateway", map[string]string{"app.kubernetes.io/name": "prometheus-pushgateway"}, false, corev1.ServicePort{Name: "http", Port: 9091}),
		svc("demo", "web", nil, false, corev1.ServicePort{Name: "http", Port: 80}),
	)
	got, err := discoverPrometheus(context.Background(), cs)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tg := range got {
		names = append(names, fmt.Sprintf("%s:%d", tg, tg.Port))
	}
	want := "metrics/prometheus-server:80 monitoring/kps-kube-prometheus-stack-prometheus:9090 monitoring/prometheus-operated:9090"
	if strings.Join(names, " ") != want {
		t.Errorf("candidatos:\n got %s\nwant %s", strings.Join(names, " "), want)
	}
}

func TestPromQueries(t *testing.T) {
	balanced := func(s string) bool {
		n := 0
		for _, r := range s {
			switch r {
			case '(', '{', '[':
				n++
			case ')', '}', ']':
				n--
			}
			if n < 0 {
				return false
			}
		}
		return n == 0
	}
	keys := []store.SeriesKey{
		{Kind: "cluster"},
		{Kind: "node", Name: "n1"},
		{Kind: "namespace", Name: "demo"},
		{Kind: "workload", Namespace: "demo", Name: "web", OwnerKind: "Deployment"},
		{Kind: "workload", Namespace: "demo", Name: "db", OwnerKind: "StatefulSet"},
		{Kind: "workload", Namespace: "kube-system", Name: "etcd-n1", OwnerKind: "Pod"},
		{Kind: "pod", Namespace: "demo", Name: "web-abc12-x1"},
	}
	for _, k := range keys {
		for _, cg := range []bool{false, true} {
			qs := promQueries(k, "120s", cg)
			for i, expr := range qs {
				if (i >= 6) != (expr == "") && k.Kind != "cluster" && k.Kind != "node" {
					t.Errorf("%v[%d]: capacidade só para cluster e nó: %q", k, i, expr)
				}
				if expr != "" && !balanced(expr) {
					t.Errorf("%v[%d] desbalanceada: %s", k, i, expr)
				}
			}
		}
	}
	cpu := promQueries(store.SeriesKey{Kind: "workload", Namespace: "demo", Name: "web", OwnerKind: "Deployment"}, "120s", false)
	for _, want := range []string{`1000 * sum(`, `rate(container_cpu_usage_seconds_total{container!="", container!="POD", pod!="", namespace="demo"}[120s])`,
		`kube_replicaset_owner{namespace="demo", owner_kind="Deployment", owner_name="web"}`} {
		if !strings.Contains(cpu[0], want) {
			t.Errorf("CPU do Deployment sem %q:\n%s", want, cpu[0])
		}
	}
	if req := cpu[2]; !strings.Contains(req, `kube_pod_container_resource_requests{resource="cpu", namespace="demo"}`) || !strings.Contains(req, `phase=~"Pending|Running"`) {
		t.Errorf("requests: %s", req)
	}
	if p := promQueries(store.SeriesKey{Kind: "pod", Namespace: "demo", Name: "web-abc12-x1"}, "120s", false); !strings.Contains(p[0], `namespace="demo", pod="web-abc12-x1"`) || p[6] != "" {
		t.Errorf("pod: %s", p[0])
	}
	pod := promQueries(store.SeriesKey{Kind: "workload", Namespace: "kube-system", Name: "etcd-n1", OwnerKind: "Pod"}, "120s", false)
	if !strings.Contains(pod[1], `pod="etcd-n1"`) || strings.Contains(pod[1], "kube_pod_owner") {
		t.Errorf("pod estático: %s", pod[1])
	}
	node := promQueries(store.SeriesKey{Kind: "node", Name: "n1"}, "120s", true)
	if !strings.Contains(node[0], `id="/"`) || !strings.Contains(node[0], `kube_node_info{node="n1"}`) || !strings.Contains(node[7], `node="n1"`) {
		t.Errorf("nó (cgroup): %s / %s", node[0], node[7])
	}
	if n := promQueries(store.SeriesKey{Kind: "node", Name: "n1"}, "120s", false); !strings.Contains(n[0], `kube_pod_info{node="n1"}`) {
		t.Errorf("nó (soma dos pods): %s", n[0])
	}
	// Nomes vêm da URL: aspas não podem escapar do seletor.
	evil := promQueries(store.SeriesKey{Kind: "namespace", Name: `x"} or vector(1) #`}, "120s", false)
	if !strings.Contains(evil[0], `namespace="x\"} or vector(1) #"`) {
		t.Errorf("escape: %s", evil[0])
	}
}

// fakeProm responde às consultas pela função answer (expr → valor por instante).
type fakeProm struct {
	srv     *httptest.Server
	queries atomic.Int64
	answer  atomic.Value // func(expr string) (float64, bool)
	down    atomic.Bool
}

func newFakeProm(t *testing.T, answer func(expr string) (float64, bool)) *fakeProm {
	f := &fakeProm{}
	f.answer.Store(answer)
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.down.Load() {
			http.Error(w, "fora do ar", http.StatusServiceUnavailable)
			return
		}
		f.queries.Add(1)
		expr := r.URL.Query().Get("query")
		v, ok := f.answer.Load().(func(string) (float64, bool))(expr)
		result := []map[string]any{}
		val := strconv.FormatFloat(v, 'f', -1, 64)
		switch r.URL.Path {
		case "/prom/api/v1/query":
			if ok {
				result = append(result, map[string]any{"metric": map[string]string{}, "value": []any{float64(time.Now().Unix()), val}})
			}
		case "/prom/api/v1/query_range":
			start, _ := strconv.ParseInt(r.URL.Query().Get("start"), 10, 64)
			end, _ := strconv.ParseInt(r.URL.Query().Get("end"), 10, 64)
			step, _ := strconv.ParseFloat(r.URL.Query().Get("step"), 64)
			var values [][]any
			for ts := start; ts <= end; ts += int64(step) {
				// Um buraco no meio do período: sem uso, sem ponto. E um buraco
				// só nos requests (coleta do kube-state-metrics que falhou).
				usage := strings.Contains(expr, "_usage_") || strings.Contains(expr, "working_set")
				if ok && !(usage && ts == start+int64(step)*2) && !(strings.Contains(expr, "requests") && ts == start+int64(step)*4) {
					values = append(values, []any{float64(ts), val})
				}
			}
			if len(values) > 0 {
				result = append(result, map[string]any{"metric": map[string]string{}, "values": values})
			}
		default:
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": result}})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// complete: um Prometheus com cAdvisor e kube-state-metrics.
func complete(expr string) (float64, bool) {
	switch {
	case strings.Contains(expr, "kube_node_status_allocatable") && strings.Contains(expr, "cpu"):
		return 4000, true
	case strings.Contains(expr, "container_cpu_usage_seconds_total"):
		return 250, true
	case strings.Contains(expr, "container_memory_working_set_bytes"):
		return 1e9, true
	case strings.Contains(expr, "limits"):
		return 0, false // ninguém com limits
	}
	return 1, true
}

func newTestHistory(t *testing.T, prom string, collector *Collector) *History {
	t.Helper()
	return NewHistory(slog.New(slog.DiscardHandler), collector, HistoryOptions{
		Prometheus: prom,
		Target:     func() (*rest.Config, string) { return &rest.Config{Host: "https://127.0.0.1:1"}, "kind" },
	})
}

func TestHistoryFromPrometheus(t *testing.T) {
	f := newFakeProm(t, complete)
	h := newTestHistory(t, f.srv.URL+"/prom", nil)
	ctx := context.Background()
	h.check(ctx)
	st := h.Status()
	if st.State != StateOK || st.Source != "prometheus" || st.Prometheus.State != PromOK || st.Prometheus.Target != f.srv.URL+"/prom" {
		t.Fatalf("status: %+v %+v", st, st.Prometheus)
	}
	if !h.prom.nodeCgroup {
		t.Error("o cgroup do nó deveria ter sido detectado")
	}
	tier, pts, err := h.History(ctx, store.SeriesKey{Kind: "cluster"}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if tier.Step != 30*time.Second {
		t.Errorf("passo: %s", tier.Step)
	}
	if len(pts) < 100 || len(pts) > 121 {
		t.Fatalf("%d pontos", len(pts))
	}
	p := pts[0]
	if p.CPU != 250 || p.Mem != 1e9 || p.CPUCap != 4000 || p.CPUReq != 1 || p.CPULim != 0 {
		t.Errorf("ponto: %+v", p)
	}
	// O instante sem uso fica de fora (lacuna).
	if pts[2].TS-pts[1].TS != 60 {
		t.Errorf("lacuna esperada entre %d e %d", pts[1].TS, pts[2].TS)
	}
	// Sem requests num instante, vale o anterior (e não uma queda a zero).
	if pts[3].CPUReq != 1 || pts[3].MemReq != 1 {
		t.Errorf("requests no instante sem coleta: %+v", pts[3])
	}
	// Namespaces não têm capacidade: 6 consultas.
	before := f.queries.Load()
	if _, _, err := h.History(ctx, store.SeriesKey{Kind: "namespace", Name: "demo"}, 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	if n := f.queries.Load() - before; n != 6 {
		t.Errorf("%d consultas para um namespace", n)
	}
}

func TestPrometheusIncompleteAndUnreachable(t *testing.T) {
	f := newFakeProm(t, func(expr string) (float64, bool) {
		if strings.Contains(expr, "kube_") {
			return 0, false // sem kube-state-metrics
		}
		return 1, true
	})
	h := newTestHistory(t, f.srv.URL+"/prom", nil)
	h.check(context.Background())
	st := h.Status()
	if st.State != "disabled" || st.Prometheus.State != PromIncomplete || strings.Join(st.Prometheus.Missing, ",") != "kube-state-metrics" {
		t.Errorf("incompleto: %+v %+v", st, st.Prometheus)
	}
	if _, _, err := h.History(context.Background(), store.SeriesKey{Kind: "cluster"}, time.Hour); err != ErrNoHistory {
		t.Errorf("sem fonte: %v", err)
	}
	if _, _, err := h.History(context.Background(), store.SeriesKey{Kind: "pod", Namespace: "demo", Name: "x"}, time.Hour); err != ErrPodNeedsPrometheus {
		t.Errorf("pod sem Prometheus: %v", err)
	}

	h = newTestHistory(t, "http://127.0.0.1:1/", nil)
	h.check(context.Background())
	if st := h.Status(); st.Prometheus.State != PromUnreachable || st.Prometheus.Error == "" {
		t.Errorf("inacessível: %+v", st.Prometheus)
	}
}

// O coletor pausa enquanto o Prometheus responde e volta quando ele cai.
func TestCollectorPausedWhilePrometheus(t *testing.T) {
	f := newFakeProm(t, complete)
	db, err := store.Open(t.TempDir() + "/kubeviz.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	src := &fakeSource{snap: snapshot()}
	c := NewCollector(slog.New(slog.DiscardHandler), db, Options{
		Target:    func() (*rest.Config, string) { return &rest.Config{}, "kind" },
		NewSource: func(*rest.Config) (Source, error) { return src, nil },
	})
	h := newTestHistory(t, f.srv.URL+"/prom", c)
	ctx := context.Background()

	h.check(ctx)
	c.collect(ctx)
	if st := c.Status(); st.State != StatePaused {
		t.Fatalf("coletor: %+v", st)
	}
	if st := h.Status(); st.State != StateOK || st.Source != "prometheus" {
		t.Fatalf("histórico: %+v", st)
	}

	f.down.Store(true)
	h.check(ctx)
	c.collect(ctx)
	st := h.Status()
	if st.Source != "collector" || st.State != StateOK || st.Prometheus.State != PromUnreachable {
		t.Errorf("depois da queda: %+v %+v", st, st.Prometheus)
	}
	if _, pts, err := h.History(ctx, store.SeriesKey{Kind: "cluster"}, time.Hour); err != nil || len(pts) != 1 {
		t.Errorf("histórico do coletor: %d pontos, %v", len(pts), err)
	}
}

func TestPrometheusOff(t *testing.T) {
	h := newTestHistory(t, "off", nil)
	h.Run(context.Background()) // volta na hora
	if st := h.Status(); st.Prometheus != nil || st.State != "disabled" {
		t.Errorf("%+v", st)
	}
}

// TestPrometheusLive roda as consultas num Prometheus de verdade
// (hack/demo/prometheus.sh + kubectl port-forward):
//
//	KUBEVIZ_TEST_PROMETHEUS=http://127.0.0.1:19090 KUBEVIZ_TEST_SERIES=workload/demo/Deployment/web go test -run Live -v ./internal/metrics/
func TestPrometheusLive(t *testing.T) {
	addr := os.Getenv("KUBEVIZ_TEST_PROMETHEUS")
	if addr == "" {
		t.Skip("KUBEVIZ_TEST_PROMETHEUS não definido")
	}
	c, err := newPromURL(addr)
	if err != nil {
		t.Fatal(err)
	}
	b := &promBackend{c: c}
	ctx := context.Background()
	missing, err := b.probe(ctx)
	if err != nil || len(missing) > 0 {
		t.Fatalf("probe: %v %v", missing, err)
	}
	t.Logf("cgroup do nó: %v", b.nodeCgroup)
	keys := []store.SeriesKey{{Kind: "cluster"}}
	for _, id := range strings.Fields(os.Getenv("KUBEVIZ_TEST_SERIES")) {
		p := strings.Split(id, "/")
		switch p[0] {
		case "node", "namespace":
			keys = append(keys, store.SeriesKey{Kind: p[0], Name: p[1]})
		case "workload":
			keys = append(keys, store.SeriesKey{Kind: "workload", Namespace: p[1], OwnerKind: p[2], Name: p[3]})
		}
	}
	for _, k := range keys {
		for _, span := range []time.Duration{15 * time.Minute, 24 * time.Hour} {
			_, pts, err := b.history(ctx, k, span)
			if err != nil {
				t.Errorf("%v %s: %v", k, span, err)
				continue
			}
			if len(pts) == 0 {
				t.Errorf("%v %s: sem pontos", k, span)
				continue
			}
			last := pts[len(pts)-1]
			t.Logf("%s/%s/%s/%s %s: %d pontos, último: cpu=%.0fm mem=%.0fMi req=%.0fm/%.0fMi lim=%.0fm/%.0fMi cap=%.0fm/%.0fMi", k.Kind, k.Namespace, k.OwnerKind, k.Name, span, len(pts),
				last.CPU, last.Mem/(1<<20), last.CPUReq, last.MemReq/(1<<20), last.CPULim, last.MemLim/(1<<20), last.CPUCap, last.MemCap/(1<<20))
		}
	}
}
