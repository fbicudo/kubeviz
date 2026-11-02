package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kubora.dev/kubora/internal/cluster"
)

type fakeCluster struct {
	mode     cluster.Mode
	current  string
	contexts []string
}

func newFakeCluster() *fakeCluster {
	return &fakeCluster{mode: cluster.ModeLocal, current: "kind-dev", contexts: []string{"kind-dev", "prod"}}
}

func (f *fakeCluster) Mode() cluster.Mode { return f.mode }

func (f *fakeCluster) Info(context.Context) cluster.Info {
	return cluster.Info{Mode: f.mode, Context: f.current, Server: "https://k8s", Reachable: true, Version: "v1.37.0"}
}

func (f *fakeCluster) Contexts() []cluster.ContextInfo {
	out := []cluster.ContextInfo{}
	for _, c := range f.contexts {
		out = append(out, cluster.ContextInfo{Name: c, Current: c == f.current})
	}
	return out
}

func (f *fakeCluster) UseContext(name string) error {
	if f.mode != cluster.ModeLocal {
		return cluster.ErrSwitchNotSupported
	}
	for _, c := range f.contexts {
		if c == name {
			f.current = name
			return nil
		}
	}
	return fmt.Errorf("%w: %q", cluster.ErrUnknownContext, name)
}

func do(t *testing.T, h http.Handler, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Host = "127.0.0.1:4466"
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

var jsonHeaders = map[string]string{"Content-Type": "application/json", "Sec-Fetch-Site": "same-origin"}

func TestClusterEndpoints(t *testing.T) {
	fc := newFakeCluster()
	h := New(slog.New(slog.DiscardHandler), testAssets, fc, Options{LoopbackOnly: true}).Handler()

	rec := do(t, h, "GET", "/api/v1/cluster", "", nil)
	var info cluster.Info
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil || info.Context != "kind-dev" || !info.Reachable {
		t.Fatalf("GET /cluster = %d %s", rec.Code, rec.Body)
	}

	rec = do(t, h, "GET", "/api/v1/contexts", "", nil)
	var ctxs contextsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &ctxs); err != nil || ctxs.Mode != cluster.ModeLocal || len(ctxs.Contexts) != 2 {
		t.Fatalf("GET /contexts = %d %s", rec.Code, rec.Body)
	}

	rec = do(t, h, "PUT", "/api/v1/contexts/current", `{"name":"prod"}`, jsonHeaders)
	if rec.Code != 200 || fc.current != "prod" {
		t.Fatalf("PUT válido = %d %s (atual %q)", rec.Code, rec.Body, fc.current)
	}
}

func TestPutContextErrors(t *testing.T) {
	fc := newFakeCluster()
	h := New(slog.New(slog.DiscardHandler), testAssets, fc, Options{}).Handler()

	cases := []struct {
		name string
		body string
		want int
	}{
		{"json inválido", `{`, 400},
		{"sem nome", `{}`, 400},
		{"contexto inexistente", `{"name":"x"}`, 404},
	}
	for _, c := range cases {
		if rec := do(t, h, "PUT", "/api/v1/contexts/current", c.body, jsonHeaders); rec.Code != c.want {
			t.Errorf("%s: status %d, quer %d (%s)", c.name, rec.Code, c.want, rec.Body)
		}
	}

	fc.mode = cluster.ModeInCluster
	if rec := do(t, h, "PUT", "/api/v1/contexts/current", `{"name":"prod"}`, jsonHeaders); rec.Code != 409 {
		t.Errorf("in-cluster: status %d, quer 409", rec.Code)
	}
}

func TestCSRFProtection(t *testing.T) {
	fc := newFakeCluster()
	h := New(slog.New(slog.DiscardHandler), testAssets, fc, Options{}).Handler()
	body := `{"name":"prod"}`

	cases := []struct {
		name    string
		headers map[string]string
		want    int
	}{
		{"formulário de outro site", map[string]string{"Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site"}, 403},
		{"fetch de outro site", map[string]string{"Content-Type": "application/json", "Origin": "https://evil.example"}, 403},
		{"sem JSON", map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, 415},
		{"mesma origem", map[string]string{"Content-Type": "application/json", "Origin": "http://127.0.0.1:4466", "Sec-Fetch-Site": "same-origin"}, 200},
		{"cliente sem navegador (curl)", map[string]string{"Content-Type": "application/json"}, 200},
	}
	for _, c := range cases {
		fc.current = "kind-dev"
		if rec := do(t, h, "PUT", "/api/v1/contexts/current", body, c.headers); rec.Code != c.want {
			t.Errorf("%s: status %d, quer %d (%s)", c.name, rec.Code, c.want, rec.Body)
		}
	}
}

func TestLoopbackHostOnly(t *testing.T) {
	h := New(slog.New(slog.DiscardHandler), testAssets, newFakeCluster(), Options{LoopbackOnly: true}).Handler()

	for host, want := range map[string]int{
		"127.0.0.1:4466":    200,
		"localhost:4466":    200,
		"[::1]:4466":        200,
		"evil.example":      403,
		"evil.example:4466": 403,
		"10.0.0.5:4466":     403,
	} {
		req := httptest.NewRequest("GET", "/api/v1/cluster", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("Host %s: status %d, quer %d", host, rec.Code, want)
		}
	}

	// Sem LoopbackOnly (in-cluster, atrás de Ingress), qualquer Host é aceito.
	h = New(slog.New(slog.DiscardHandler), testAssets, newFakeCluster(), Options{}).Handler()
	req := httptest.NewRequest("GET", "/api/v1/cluster", nil)
	req.Host = "kubora.empresa.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Errorf("in-cluster com Host público: status %d", rec.Code)
	}
}
