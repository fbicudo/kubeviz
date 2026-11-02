package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

var testAssets = fstest.MapFS{
	"index.html":     {Data: []byte("<!doctype html><div id=root></div>")},
	"assets/app.js":  {Data: []byte("console.log(1)")},
	"favicon.svg":    {Data: []byte("<svg/>")},
	"assets/sub/x.c": {Data: []byte("x")},
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	s := newServer(newFakeCluster(), Options{LoopbackOnly: true})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func get(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func TestHealth(t *testing.T) {
	ts := newTestServer(t)
	for _, p := range []string{"/healthz", "/readyz"} {
		resp, body := get(t, ts.URL+p)
		if resp.StatusCode != 200 || body != "ok" {
			t.Errorf("%s = %d %q", p, resp.StatusCode, body)
		}
	}
}

func TestVersion(t *testing.T) {
	ts := newTestServer(t)
	resp, body := get(t, ts.URL+"/api/v1/version")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var v struct{ Version string }
	if err := json.Unmarshal([]byte(body), &v); err != nil || v.Version == "" {
		t.Errorf("corpo inesperado %q (%v)", body, err)
	}
}

func TestUnknownAPIRouteIsJSON404(t *testing.T) {
	ts := newTestServer(t)
	resp, body := get(t, ts.URL+"/api/v1/nao-existe")
	if resp.StatusCode != 404 {
		t.Errorf("status %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "application/json") || strings.Contains(body, "<div") {
		t.Errorf("API deveria responder JSON, recebeu %q", body)
	}
}

func TestSPA(t *testing.T) {
	ts := newTestServer(t)

	resp, body := get(t, ts.URL+"/assets/app.js")
	if body != "console.log(1)" {
		t.Errorf("asset = %q", body)
	}
	if !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Errorf("assets com hash deveriam ser imutáveis, Cache-Control=%q", resp.Header.Get("Cache-Control"))
	}

	// Rotas do navegador e diretórios caem no index.html.
	for _, p := range []string{"/", "/workloads/pods", "/assets/sub/"} {
		resp, body := get(t, ts.URL+p)
		if resp.StatusCode != 200 || !strings.Contains(body, "id=root") {
			t.Errorf("%s = %d %q, esperava index.html", p, resp.StatusCode, body)
		}
		if resp.Header.Get("Cache-Control") != "no-cache" {
			t.Errorf("%s: index.html não pode ficar em cache", p)
		}
	}
}

func TestSPANotBuilt(t *testing.T) {
	s := New(slog.New(slog.DiscardHandler), fstest.MapFS{}, newFakeCluster(), Options{})
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	_, body := get(t, ts.URL+"/")
	if !strings.Contains(body, "não foi compilada") {
		t.Errorf("esperava aviso de UI não compilada, recebeu %q", body)
	}
}

func TestSecurityHeaders(t *testing.T) {
	ts := newTestServer(t)
	resp, _ := get(t, ts.URL+"/")
	for _, h := range []string{"Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"} {
		if resp.Header.Get(h) == "" {
			t.Errorf("cabeçalho %s ausente", h)
		}
	}
}

func TestGracefulShutdown(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- newServer(newFakeCluster(), Options{LoopbackOnly: true}).Serve(ctx, ln)
	}()

	if resp, _ := get(t, "http://"+ln.Addr().String()+"/healthz"); resp.StatusCode != 200 {
		t.Fatalf("servidor não respondeu: %d", resp.StatusCode)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve retornou erro: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("servidor não encerrou")
	}
}
