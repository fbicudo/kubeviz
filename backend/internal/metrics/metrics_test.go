package metrics

import (
	"context"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/store"
)

func snapshot() Snapshot {
	return Snapshot{
		Nodes: []NodeInfo{{Name: "n1", CPUCap: 4000, MemCap: 8e9}, {Name: "n2", CPUCap: 2000, MemCap: 4e9}},
		Pods: []PodInfo{
			{Namespace: "demo", Name: "web-abc12-x1", Node: "n1", Active: true, OwnerKind: "ReplicaSet", OwnerName: "web-abc12", TemplateHash: "abc12", CPUReq: 100, MemReq: 64e6, CPULim: 500},
			{Namespace: "demo", Name: "web-abc12-x2", Node: "n2", Active: true, OwnerKind: "ReplicaSet", OwnerName: "web-abc12", TemplateHash: "abc12", CPUReq: 100, MemReq: 64e6, CPULim: 500},
			{Namespace: "kube-system", Name: "etcd-n1", Node: "n1", Active: true, OwnerKind: "Node", OwnerName: "n1", CPUReq: 100},
			{Namespace: "demo", Name: "job-x", Node: "n2", Active: false, OwnerKind: "Job", OwnerName: "job", CPUReq: 1000},
		},
		NodeUsage: map[string]Usage{"n1": {CPU: 1000, Mem: 2e9}, "n2": {CPU: 500, Mem: 1e9}},
		PodUsage:  map[string]Usage{"demo/web-abc12-x1": {CPU: 20, Mem: 10e6}, "demo/web-abc12-x2": {CPU: 30, Mem: 12e6}, "kube-system/etcd-n1": {CPU: 90, Mem: 300e6}},
	}
}

func TestAggregate(t *testing.T) {
	out := Aggregate(snapshot())
	cluster := out[store.SeriesKey{Kind: "cluster"}]
	if cluster.CPU != 1500 || cluster.CPUCap != 6000 || cluster.CPUReq != 300 || cluster.CPULim != 1000 {
		t.Errorf("cluster: %+v", cluster)
	}
	if n1 := out[store.SeriesKey{Kind: "node", Name: "n1"}]; n1.CPU != 1000 || n1.CPUCap != 4000 || n1.CPUReq != 200 {
		t.Errorf("n1: %+v", n1)
	}
	web := out[store.SeriesKey{Kind: "workload", Namespace: "demo", Name: "web", OwnerKind: "Deployment"}]
	if web.CPU != 50 || web.CPUReq != 200 || web.Mem != 22e6 {
		t.Errorf("Deployment web: %+v", web)
	}
	// Pod estático: ele mesmo, não o nó.
	if _, ok := out[store.SeriesKey{Kind: "workload", Namespace: "kube-system", Name: "etcd-n1", OwnerKind: "Pod"}]; !ok {
		t.Error("pod estático deveria ser o próprio workload")
	}
	// Job terminado: aparece, mas não reserva.
	if job := out[store.SeriesKey{Kind: "workload", Namespace: "demo", Name: "job", OwnerKind: "Job"}]; job.CPUReq != 0 {
		t.Errorf("pod terminado reservando: %+v", job)
	}
	if ns := out[store.SeriesKey{Kind: "namespace", Name: "demo"}]; ns.CPU != 50 || ns.CPUReq != 200 {
		t.Errorf("namespace demo: %+v", ns)
	}
}

type fakeSource struct {
	mu   sync.Mutex
	err  error
	snap Snapshot
	stop bool
}

func (f *fakeSource) Snapshot(context.Context) (Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap, f.err
}
func (f *fakeSource) Stop() { f.stop = true }

func TestCollector(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "kubeviz.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	src := &fakeSource{err: ErrNoMetricsAPI}
	cluster := "kind-dev"
	var created []*fakeSource
	c := NewCollector(slog.New(slog.DiscardHandler), db, Options{
		Interval: time.Hour,
		Target:   func() (*rest.Config, string) { return &rest.Config{}, cluster },
		NewSource: func(*rest.Config) (Source, error) {
			created = append(created, src)
			return src, nil
		},
	})
	ctx := context.Background()

	if s := c.Status(); s.State != StateStarting {
		t.Fatalf("antes: %+v", s)
	}
	c.collect(ctx)
	if s := c.Status(); s.State != StateMissing || s.Cluster != "kind-dev" {
		t.Fatalf("sem metrics-server: %+v", s)
	}
	src.err = ErrForbidden
	c.collect(ctx)
	if s := c.Status(); s.State != StateForbidden {
		t.Fatalf("sem permissão: %+v", s)
	}

	src.err, src.snap = nil, snapshot()
	c.collect(ctx)
	s := c.Status()
	if s.State != StateOK || s.Series < 7 || s.LastSample.IsZero() || s.DBBytes == 0 {
		t.Fatalf("coletando: %+v", s)
	}
	_, pts, err := c.History(ctx, store.SeriesKey{Kind: "cluster"}, time.Hour)
	if err != nil || len(pts) != 1 || pts[0].CPU != 1500 {
		t.Fatalf("histórico: %+v %v", pts, err)
	}

	// Outro contexto do kubeconfig: nova fonte, e os dados não se misturam.
	cluster = "producao"
	c.collect(ctx)
	if len(created) != 2 || !created[0].stop {
		t.Errorf("a fonte do cluster anterior deveria parar e outra começar: %d criadas", len(created))
	}
	if _, pts, _ := c.History(ctx, store.SeriesKey{Kind: "cluster"}, time.Hour); len(pts) != 1 {
		t.Errorf("histórico do cluster novo: %d pontos", len(pts))
	}
}
