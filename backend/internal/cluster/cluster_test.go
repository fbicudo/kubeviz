package cluster

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"k8s.io/client-go/rest"
)

// fakeAPIServer responde /version como um API server do Kubernetes.
func fakeAPIServer(t *testing.T, gitVersion string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/version" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"gitVersion":%q,"platform":"linux/amd64"}`, gitVersion)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// writeKubeconfig cria um kubeconfig com os contextos "a" (servidor A) e "b"
// (servidor B), sendo "a" o atual.
func writeKubeconfig(t *testing.T, serverA, serverB string) string {
	t.Helper()
	content := fmt.Sprintf(`apiVersion: v1
kind: Config
current-context: a
clusters:
- name: ca
  cluster: {server: %s}
- name: cb
  cluster: {server: %s}
users:
- name: u
  user: {token: t}
contexts:
- name: a
  context: {cluster: ca, user: u, namespace: dev}
- name: b
  context: {cluster: cb, user: u}
`, serverA, serverB)
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLocalModeInfoAndContexts(t *testing.T) {
	a := fakeAPIServer(t, "v1.37.0")
	b := fakeAPIServer(t, "v1.36.4")
	kc := writeKubeconfig(t, a.URL, b.URL)

	m, err := New(Options{Kubeconfig: kc, UserAgent: "kubora-test"})
	if err != nil {
		t.Fatal(err)
	}
	if m.Mode() != ModeLocal {
		t.Fatalf("modo = %s", m.Mode())
	}

	info := m.Info(context.Background())
	if !info.Reachable || info.Version != "v1.37.0" || info.Context != "a" || info.Server != a.URL {
		t.Fatalf("info inesperado: %+v", info)
	}

	ctxs := m.Contexts()
	if len(ctxs) != 2 || ctxs[0].Name != "a" || !ctxs[0].Current || ctxs[0].Namespace != "dev" || ctxs[1].Current {
		t.Fatalf("contextos inesperados: %+v", ctxs)
	}

	if err := m.UseContext("b"); err != nil {
		t.Fatal(err)
	}
	if info := m.Info(context.Background()); info.Version != "v1.36.4" || info.Context != "b" {
		t.Fatalf("após troca: %+v", info)
	}
	if got := m.RESTConfig().UserAgent; got != "kubora-test" {
		t.Errorf("UserAgent = %q", got)
	}
}

func TestUseContextDoesNotModifyKubeconfig(t *testing.T) {
	a := fakeAPIServer(t, "v1.37.0")
	kc := writeKubeconfig(t, a.URL, a.URL)
	before, _ := os.ReadFile(kc)

	m, err := New(Options{Kubeconfig: kc})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.UseContext("b"); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(kc)
	if string(before) != string(after) {
		t.Error("o kubeconfig do usuário foi alterado")
	}
}

func TestInitialContextOption(t *testing.T) {
	a := fakeAPIServer(t, "v1.37.0")
	m, err := New(Options{Kubeconfig: writeKubeconfig(t, a.URL, a.URL), Context: "b"})
	if err != nil {
		t.Fatal(err)
	}
	if info := m.Info(context.Background()); info.Context != "b" {
		t.Errorf("contexto inicial = %q", info.Context)
	}
}

func TestUnknownContext(t *testing.T) {
	a := fakeAPIServer(t, "v1.37.0")
	m, err := New(Options{Kubeconfig: writeKubeconfig(t, a.URL, a.URL)})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.UseContext("nao-existe"); !errors.Is(err, ErrUnknownContext) {
		t.Errorf("erro = %v", err)
	}
	if _, err := New(Options{Kubeconfig: writeKubeconfig(t, a.URL, a.URL), Context: "x"}); !errors.Is(err, ErrUnknownContext) {
		t.Errorf("contexto inicial inexistente: erro = %v", err)
	}
}

func TestUnreachableCluster(t *testing.T) {
	a := fakeAPIServer(t, "v1.37.0")
	url := a.URL
	a.Close()

	m, err := New(Options{Kubeconfig: writeKubeconfig(t, url, url)})
	if err != nil {
		t.Fatal(err)
	}
	info := m.Info(context.Background())
	if info.Reachable || info.Error == "" {
		t.Errorf("esperava cluster inacessível com erro, veio %+v", info)
	}
}

func TestMissingKubeconfig(t *testing.T) {
	if _, err := New(Options{Kubeconfig: filepath.Join(t.TempDir(), "nao-existe")}); err == nil {
		t.Error("esperava erro para kubeconfig inexistente")
	}
}

func TestResolveMode(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	cases := []struct {
		opts Options
		want Mode
	}{
		{Options{}, ModeInCluster},
		{Options{Kubeconfig: "/tmp/kc"}, ModeLocal},
		{Options{Mode: "local"}, ModeLocal},
		{Options{Mode: "in-cluster", Kubeconfig: "/tmp/kc"}, ModeInCluster},
	}
	for _, c := range cases {
		if got, err := resolveMode(c.opts); err != nil || got != c.want {
			t.Errorf("resolveMode(%+v) = %s, %v; quer %s", c.opts, got, err, c.want)
		}
	}
	if _, err := resolveMode(Options{Mode: "x"}); err == nil {
		t.Error("esperava erro para modo inválido")
	}

	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	if got, _ := resolveMode(Options{}); got != ModeLocal {
		t.Errorf("fora de um pod, auto deveria ser local, veio %s", got)
	}
}

func TestConfigForTokenDropsServiceAccountCredentials(t *testing.T) {
	base := &rest.Config{
		Host:            "https://10.0.0.1:443",
		BearerToken:     "token-da-serviceaccount",
		BearerTokenFile: "/var/run/secrets/token",
		Impersonate:     rest.ImpersonationConfig{UserName: "admin"},
		TLSClientConfig: rest.TLSClientConfig{CAData: []byte("ca"), CertData: []byte("cert"), KeyData: []byte("key")},
	}
	m := NewInCluster(base, "kubora-test")

	cfg := m.ConfigForToken("token-do-usuario")
	if cfg.BearerToken != "token-do-usuario" || cfg.BearerTokenFile != "" {
		t.Errorf("token = %q, arquivo = %q", cfg.BearerToken, cfg.BearerTokenFile)
	}
	if cfg.Impersonate.UserName != "" || cfg.CertData != nil || cfg.KeyData != nil {
		t.Error("credenciais da ServiceAccount vazaram para a configuração do usuário")
	}
	if cfg.Host != base.Host || string(cfg.CAData) != "ca" || cfg.UserAgent != "kubora-test" {
		t.Errorf("endereço/CA/UserAgent não preservados: %+v", cfg)
	}
}

func TestInClusterCannotSwitch(t *testing.T) {
	m := &Manager{mode: ModeInCluster}
	if err := m.UseContext("a"); !errors.Is(err, ErrSwitchNotSupported) {
		t.Errorf("erro = %v", err)
	}
	if got := m.Contexts(); len(got) != 0 {
		t.Errorf("contextos = %v", got)
	}
}
