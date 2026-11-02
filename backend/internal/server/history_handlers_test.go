package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	authzv1 "k8s.io/api/authorization/v1"
	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/metrics"
	"github.com/fbicudo/kubeviz/backend/internal/store"
)

type fakeHistory struct{ asked []store.SeriesKey }

func (f *fakeHistory) Status() metrics.Status {
	return metrics.Status{State: metrics.StateOK, Interval: "30s"}
}
func (f *fakeHistory) History(_ context.Context, k store.SeriesKey, span time.Duration) (store.Tier, []store.Point, error) {
	f.asked = append(f.asked, k)
	tier := store.TierFor(store.Tiers(0), span)
	return tier, []store.Point{{TS: 1000, Sample: store.Sample{CPU: 250, Mem: 1e9, CPUCap: 4000}}}, nil
}

func TestHistoryAPI(t *testing.T) {
	hist := &fakeHistory{}
	var checks []authzv1.ResourceAttributes
	// Quem consulta só pode listar pods em demo (nada de nós).
	canI := func(_ context.Context, _ *rest.Config, a authzv1.ResourceAttributes) (bool, error) {
		checks = append(checks, a)
		return a.Resource == "pods" && a.Namespace == "demo", nil
	}
	s := New(slog.New(slog.DiscardHandler), testAssets, newFakeCluster(), Options{History: hist, CanI: canI, WhoAmI: fakeWhoAmI})
	h := s.Handler()
	cookie := map[string]string{"Cookie": loggedIn(s, "token-ana")}

	get := func(q string) (int, map[string]any) {
		rec := do(t, h, "GET", "/api/v1/metrics/history?"+q, "", cookie)
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body
	}

	code, body := get("kind=workload&namespace=demo&name=web&ownerKind=Deployment&range=7d")
	if code != 200 || body["step"].(float64) != 300 {
		t.Fatalf("workload em demo: %d %v", code, body)
	}
	if pts := body["points"].([]any); len(pts) != 1 || pts[0].([]any)[1].(float64) != 250 {
		t.Errorf("pontos: %v", body["points"])
	}
	if code, _ := get("kind=namespace&name=demo&range=1h"); code != 200 {
		t.Errorf("namespace demo: %d", code)
	}
	for _, q := range []string{"kind=cluster&range=1h", "kind=node&name=n1&range=1h", "kind=namespace&name=kube-system&range=1h", "kind=workload&namespace=kube-system&name=coredns&ownerKind=Deployment&range=1h"} {
		if code, _ := get(q); code != 403 {
			t.Errorf("%s: %d, quer 403", q, code)
		}
	}
	for _, q := range []string{"kind=cluster&range=2h", "kind=pod&name=x&range=1h", "kind=node&range=1h", "kind=workload&name=web&range=1h"} {
		if code, _ := get(q); code != 400 {
			t.Errorf("%s: %d, quer 400", q, code)
		}
	}
	// A permissão fica guardada por um minuto: a mesma pergunta não se repete.
	before := len(checks)
	get("kind=namespace&name=demo&range=24h")
	if len(checks) != before {
		t.Errorf("a permissão deveria vir do cache (%d → %d perguntas)", before, len(checks))
	}
	if len(hist.asked) != 3 {
		t.Errorf("histórico consultado só quando permitido: %d consultas", len(hist.asked))
	}
	// Sem sessão, nada.
	if rec := do(t, h, "GET", "/api/v1/metrics/history?kind=cluster&range=1h", "", nil); rec.Code != 401 {
		t.Errorf("sem sessão: %d", rec.Code)
	}
}

func TestHistoryDisabled(t *testing.T) {
	s := newServer(newFakeCluster(), Options{})
	h := s.Handler()
	cookie := map[string]string{"Cookie": loggedIn(s, "token-ana")}
	if rec := do(t, h, "GET", "/api/v1/metrics/status", "", cookie); rec.Code != 200 || !json.Valid(rec.Body.Bytes()) || string(rec.Body.Bytes()) == "" {
		t.Fatalf("status: %d", rec.Code)
	} else if !strings.Contains(rec.Body.String(), `"state":"disabled"`) {
		t.Errorf("status desativado: %s", rec.Body)
	}
	if rec := do(t, h, "GET", "/api/v1/metrics/history?kind=cluster&range=1h", "", cookie); rec.Code != 404 {
		t.Errorf("histórico desativado: %d", rec.Code)
	}
}
