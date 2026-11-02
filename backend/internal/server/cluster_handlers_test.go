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

	"k8s.io/client-go/rest"

	"kubeviz.dev/kubeviz/internal/auth"
	"kubeviz.dev/kubeviz/internal/cluster"
)

type fakeCluster struct {
	mode     cluster.Mode
	current  string
	contexts []string
	host     string // endereço do API server falso usado pelo proxy
}

func newFakeCluster() *fakeCluster {
	return &fakeCluster{mode: cluster.ModeLocal, current: "kind-dev", contexts: []string{"kind-dev", "prod"}, host: "https://k8s.invalid"}
}

func (f *fakeCluster) Mode() cluster.Mode { return f.mode }

func (f *fakeCluster) Info(context.Context) cluster.Info {
	return cluster.Info{Mode: f.mode, Context: f.current, Server: f.host, Reachable: true, Version: "v1.37.0"}
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

// No modo local, o "kubeconfig" falso usa o token "kubeconfig-token".
func (f *fakeCluster) RESTConfig() *rest.Config {
	return &rest.Config{Host: f.host, BearerToken: "kubeconfig-token"}
}

func (f *fakeCluster) ConfigForToken(token string) *rest.Config {
	return &rest.Config{Host: f.host, BearerToken: token}
}

// fakeWhoAmI aceita os tokens "token-ana" e "kubeconfig-token".
func fakeWhoAmI(_ context.Context, cfg *rest.Config) (auth.User, error) {
	switch cfg.BearerToken {
	case "token-ana":
		return auth.User{Username: "ana", Groups: []string{"dev"}}, nil
	case "kubeconfig-token":
		return auth.User{Username: "kubernetes-admin"}, nil
	}
	return auth.User{}, auth.ErrInvalidCredentials
}

func newServer(fc *fakeCluster, opts Options) *Server {
	opts.WhoAmI = fakeWhoAmI
	return New(slog.New(slog.DiscardHandler), testAssets, fc, opts)
}

// loggedIn cria uma sessão diretamente e devolve o cabeçalho Cookie.
func loggedIn(s *Server, token string) string {
	sess := s.sessions.Create(auth.User{Username: "ana"}, token)
	return sessionCookie + "=" + sess.ID
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

func with(base map[string]string, extra ...string) map[string]string {
	out := map[string]string{}
	for k, v := range base {
		out[k] = v
	}
	for i := 0; i+1 < len(extra); i += 2 {
		out[extra[i]] = extra[i+1]
	}
	return out
}

var jsonHeaders = map[string]string{"Content-Type": "application/json", "Sec-Fetch-Site": "same-origin"}

func TestClusterEndpoints(t *testing.T) {
	fc := newFakeCluster()
	s := newServer(fc, Options{LoopbackOnly: true})
	h := s.Handler()
	cookie := map[string]string{"Cookie": loggedIn(s, "")}

	rec := do(t, h, "GET", "/api/v1/cluster", "", cookie)
	var info cluster.Info
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil || info.Context != "kind-dev" || !info.Reachable {
		t.Fatalf("GET /cluster = %d %s", rec.Code, rec.Body)
	}

	rec = do(t, h, "GET", "/api/v1/contexts", "", cookie)
	var ctxs contextsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &ctxs); err != nil || ctxs.Mode != cluster.ModeLocal || len(ctxs.Contexts) != 2 {
		t.Fatalf("GET /contexts = %d %s", rec.Code, rec.Body)
	}

	rec = do(t, h, "PUT", "/api/v1/contexts/current", `{"name":"prod"}`, with(jsonHeaders, "Cookie", cookie["Cookie"]))
	if rec.Code != 200 || fc.current != "prod" {
		t.Fatalf("PUT válido = %d %s (atual %q)", rec.Code, rec.Body, fc.current)
	}
}

func TestProtectedRoutesRequireSession(t *testing.T) {
	h := newServer(newFakeCluster(), Options{}).Handler()
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/v1/cluster"},
		{"GET", "/api/v1/contexts"},
		{"PUT", "/api/v1/contexts/current"},
		{"GET", "/api/k8s/api/v1/pods"},
	} {
		rec := do(t, h, r.method, r.path, `{"name":"prod"}`, with(jsonHeaders, "Cookie", sessionCookie+"=inventado"))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s sem sessão válida: status %d, quer 401", r.method, r.path, rec.Code)
		}
	}
}

func TestPutContextErrors(t *testing.T) {
	fc := newFakeCluster()
	s := newServer(fc, Options{})
	h := s.Handler()
	hdr := with(jsonHeaders, "Cookie", loggedIn(s, ""))

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
		if rec := do(t, h, "PUT", "/api/v1/contexts/current", c.body, hdr); rec.Code != c.want {
			t.Errorf("%s: status %d, quer %d (%s)", c.name, rec.Code, c.want, rec.Body)
		}
	}

	fc.mode = cluster.ModeInCluster
	if rec := do(t, h, "PUT", "/api/v1/contexts/current", `{"name":"prod"}`, hdr); rec.Code != 409 {
		t.Errorf("in-cluster: status %d, quer 409", rec.Code)
	}
}

func TestCSRFProtection(t *testing.T) {
	fc := newFakeCluster()
	s := newServer(fc, Options{})
	h := s.Handler()
	cookie := loggedIn(s, "")
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
		if rec := do(t, h, "PUT", "/api/v1/contexts/current", body, with(c.headers, "Cookie", cookie)); rec.Code != c.want {
			t.Errorf("%s: status %d, quer %d (%s)", c.name, rec.Code, c.want, rec.Body)
		}
	}
}

func TestLoopbackHostOnly(t *testing.T) {
	h := newServer(newFakeCluster(), Options{LoopbackOnly: true}).Handler()

	for host, want := range map[string]int{
		"127.0.0.1:4466":    200,
		"localhost:4466":    200,
		"[::1]:4466":        200,
		"evil.example":      403,
		"evil.example:4466": 403,
		"10.0.0.5:4466":     403,
	} {
		req := httptest.NewRequest("GET", "/api/v1/version", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("Host %s: status %d, quer %d", host, rec.Code, want)
		}
	}

	// Sem LoopbackOnly (in-cluster, atrás de Ingress), qualquer Host é aceito.
	h = newServer(newFakeCluster(), Options{}).Handler()
	req := httptest.NewRequest("GET", "/api/v1/version", nil)
	req.Host = "kubeviz.empresa.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Errorf("in-cluster com Host público: status %d", rec.Code)
	}
}
