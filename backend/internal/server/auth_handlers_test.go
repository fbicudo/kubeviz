package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

func sessionOf(t *testing.T, h http.Handler, cookie string) sessionResponse {
	t.Helper()
	rec := do(t, h, "GET", "/api/v1/auth/session", "", map[string]string{"Cookie": cookie})
	var resp sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("sessão: %d %s", rec.Code, rec.Body)
	}
	return resp
}

func cookieFrom(t *testing.T, rec *httptest.ResponseRecorder) (*http.Cookie, string) {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie {
			return c, c.Name + "=" + c.Value
		}
	}
	t.Fatalf("cookie de sessão ausente (status %d)", rec.Code)
	return nil, ""
}

func TestLocalLogin(t *testing.T) {
	h := newServer(newFakeCluster(), Options{LocalToken: "segredo"}).Handler()

	if s := sessionOf(t, h, ""); s.Authenticated || s.Mode != cluster.ModeLocal {
		t.Fatalf("sem login: %+v", s)
	}

	if rec := do(t, h, "GET", "/auth/local?token=errado", "", nil); rec.Code != 401 || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("token errado: status %d, cookies %v", rec.Code, rec.Result().Cookies())
	}

	rec := do(t, h, "GET", "/auth/local?token=segredo", "", nil)
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/" {
		t.Fatalf("token certo: status %d, Location %q", rec.Code, rec.Header().Get("Location"))
	}
	c, cookie := cookieFrom(t, rec)
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Secure {
		t.Errorf("atributos do cookie: %+v", c)
	}

	// No modo local, a identidade vem do kubeconfig, consultada na hora.
	s := sessionOf(t, h, cookie)
	if !s.Authenticated || s.User == nil || s.User.Username != "kubernetes-admin" {
		t.Fatalf("após login: %+v", s)
	}

	// Login por token não existe no modo local.
	if rec := do(t, h, "POST", "/api/v1/auth/login", `{"token":"token-ana"}`, jsonHeaders); rec.Code != 409 {
		t.Errorf("login por token no modo local: status %d, quer 409", rec.Code)
	}
}

func TestLocalLoginDisabledWithoutToken(t *testing.T) {
	h := newServer(newFakeCluster(), Options{}).Handler()
	if rec := do(t, h, "GET", "/auth/local?token=", "", nil); rec.Code != 404 {
		t.Errorf("status %d, quer 404", rec.Code)
	}
}

func TestInClusterLoginAndLogout(t *testing.T) {
	fc := newFakeCluster()
	fc.mode = cluster.ModeInCluster
	h := newServer(fc, Options{}).Handler()

	if rec := do(t, h, "GET", "/auth/local?token=x", "", nil); rec.Code != 404 {
		t.Errorf("link local no modo in-cluster: status %d, quer 404", rec.Code)
	}
	if rec := do(t, h, "POST", "/api/v1/auth/login", `{"token":"falso"}`, jsonHeaders); rec.Code != 401 {
		t.Fatalf("token inválido: status %d", rec.Code)
	}
	if rec := do(t, h, "POST", "/api/v1/auth/login", `{}`, jsonHeaders); rec.Code != 400 {
		t.Fatalf("sem token: status %d", rec.Code)
	}

	rec := do(t, h, "POST", "/api/v1/auth/login", `{"token":"token-ana"}`, with(jsonHeaders, "X-Forwarded-Proto", "https"))
	if rec.Code != 200 {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "token-ana") {
		t.Error("o token do usuário não pode voltar ao navegador")
	}
	c, cookie := cookieFrom(t, rec)
	if !c.Secure {
		t.Error("atrás de HTTPS, o cookie deve ser Secure")
	}
	if s := sessionOf(t, h, cookie); s.User == nil || s.User.Username != "ana" {
		t.Fatalf("sessão: %+v", s)
	}

	if rec := do(t, h, "POST", "/api/v1/auth/logout", `{}`, with(jsonHeaders, "Cookie", cookie)); rec.Code != 204 {
		t.Fatalf("logout: %d", rec.Code)
	}
	if s := sessionOf(t, h, cookie); s.Authenticated {
		t.Error("sessão continua válida após logout")
	}
}

func TestProxyUsesSessionCredentials(t *testing.T) {
	var got *http.Request
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(r.Context())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"PodList","items":[]}`))
	}))
	defer api.Close()

	fc := newFakeCluster()
	fc.mode = cluster.ModeInCluster
	fc.host = api.URL
	s := newServer(fc, Options{})
	h := s.Handler()
	cookie := loggedIn(s, "token-ana")

	rec := do(t, h, "GET", "/api/k8s/api/v1/namespaces/dev/pods?limit=5", "", map[string]string{
		"Cookie":               cookie,
		"Authorization":        "Bearer token-roubado",
		"Impersonate-User":     "system:admin",
		"Impersonate-Group":    "system:masters",
		"Impersonate-Extra-Fo": "x",
	})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "PodList") {
		t.Fatalf("proxy: %d %s", rec.Code, rec.Body)
	}
	if got.URL.Path != "/api/v1/namespaces/dev/pods" || got.URL.RawQuery != "limit=5" {
		t.Errorf("caminho repassado: %s?%s", got.URL.Path, got.URL.RawQuery)
	}
	if a := got.Header.Get("Authorization"); a != "Bearer token-ana" {
		t.Errorf("Authorization repassado = %q, quer o token da sessão", a)
	}
	for name := range got.Header {
		if strings.HasPrefix(name, "Impersonate-") || name == "Cookie" {
			t.Errorf("cabeçalho %s não deveria chegar ao cluster", name)
		}
	}
}

func TestProxyLocalModeUsesKubeconfig(t *testing.T) {
	var auth string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
	}))
	defer api.Close()

	fc := newFakeCluster()
	fc.host = api.URL
	s := newServer(fc, Options{})
	do(t, s.Handler(), "GET", "/api/k8s/version", "", map[string]string{"Cookie": loggedIn(s, "")})
	if auth != "Bearer kubeconfig-token" {
		t.Errorf("Authorization = %q, quer as credenciais do kubeconfig", auth)
	}
}

func TestProxyClusterDown(t *testing.T) {
	api := httptest.NewServer(http.NotFoundHandler())
	url := api.URL
	api.Close()

	fc := newFakeCluster()
	fc.host = url
	s := newServer(fc, Options{})
	rec := do(t, s.Handler(), "GET", "/api/k8s/version", "", map[string]string{"Cookie": loggedIn(s, "")})
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "inacessível") {
		t.Errorf("cluster fora do ar: %d %s", rec.Code, rec.Body)
	}
}

// O watch do Kubernetes é um stream longo: cada evento precisa chegar ao
// navegador assim que gerado, sem esperar a resposta terminar.
func TestProxyStreamsWatchWithoutBuffering(t *testing.T) {
	release := make(chan struct{})
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"type":"ADDED","object":{"metadata":{"name":"primeiro"}}}`)
		w.(http.Flusher).Flush()
		<-release // o segundo evento só existe depois que o primeiro chegou
		fmt.Fprintln(w, `{"type":"ADDED","object":{"metadata":{"name":"segundo"}}}`)
	}))
	defer api.Close()

	fc := newFakeCluster()
	fc.host = api.URL
	s := newServer(fc, Options{})
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	req, _ := http.NewRequest("GET", srv.URL+"/api/k8s/api/v1/pods?watch=1", nil)
	req.Header.Set("Cookie", loggedIn(s, ""))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	lines := bufio.NewScanner(resp.Body)
	got := make(chan string, 2)
	go func() {
		for lines.Scan() {
			got <- lines.Text()
		}
		close(got)
	}()

	select {
	case line := <-got:
		if !strings.Contains(line, "primeiro") {
			t.Fatalf("primeiro evento = %q", line)
		}
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("o primeiro evento ficou retido no proxy")
	}
	close(release)
	if line := <-got; !strings.Contains(line, "segundo") {
		t.Fatalf("segundo evento = %q", line)
	}
}

// Server-side apply usa application/apply-patch+yaml; precisa passar pelo
// proxy com a credencial da sessão.
func TestProxyAcceptsKubernetesPatchTypes(t *testing.T) {
	var gotCT, gotMethod string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCT, gotMethod = r.Header.Get("Content-Type"), r.Method
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"Deployment"}`))
	}))
	defer api.Close()

	fc := newFakeCluster()
	fc.host = api.URL
	s := newServer(fc, Options{})
	h := s.Handler()
	for _, ct := range []string{"application/apply-patch+yaml", "application/merge-patch+json", "application/strategic-merge-patch+json", "application/json-patch+json"} {
		rec := do(t, h, "PATCH", "/api/k8s/apis/apps/v1/namespaces/demo/deployments/web?fieldManager=kubeviz", "kind: Deployment",
			map[string]string{"Cookie": loggedIn(s, ""), "Content-Type": ct, "Sec-Fetch-Site": "same-origin"})
		if rec.Code != 200 || gotCT != ct || gotMethod != "PATCH" {
			t.Errorf("%s: status %d, repassado %q %q", ct, rec.Code, gotMethod, gotCT)
		}
	}
}
