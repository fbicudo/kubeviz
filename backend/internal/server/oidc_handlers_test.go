package server

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/auth/oidctest"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

// oidcWhoAmI imita o API server: aceita a credencial do KubeViz agindo como
// outro usuário (impersonation) e ID tokens (modo token).
func oidcWhoAmI(_ context.Context, cfg *rest.Config) (auth.User, error) {
	switch {
	case cfg.BearerToken == "kubeconfig-token" && cfg.Impersonate.UserName != "":
		return auth.User{Username: cfg.Impersonate.UserName, Groups: append(cfg.Impersonate.Groups, "system:authenticated")}, nil
	case strings.HasPrefix(cfg.BearerToken, "eyJ"):
		return auth.User{Username: "https://idp#ana", Groups: []string{"dev"}}, nil
	}
	return fakeWhoAmI(context.Background(), cfg)
}

func newOIDCServer(t *testing.T, p *oidctest.Provider, fc *fakeCluster, mode auth.OIDCMode, whoAmI func(context.Context, *rest.Config) (auth.User, error)) http.Handler {
	t.Helper()
	o, err := auth.NewOIDC(auth.OIDCConfig{
		IssuerURL: p.URL, ClientID: oidctest.ClientID, ClientSecret: oidctest.ClientSecret,
		RedirectURL: "http://127.0.0.1:4466/auth/oidc/callback", Scopes: []string{"openid", "email"},
		UsernameClaim: "email", GroupsClaim: "groups", UsernamePrefix: "oidc:", GroupsPrefix: "oidc:",
		Mode: mode, DisplayName: "Dex",
	})
	if err != nil {
		t.Fatal(err)
	}
	return New(slog.New(slog.DiscardHandler), testAssets, fc, Options{OIDC: o, WhoAmI: whoAmI}).Handler()
}

// oidcLoginFlow percorre login → provedor → retorno e devolve a resposta do
// retorno.
func oidcLoginFlow(t *testing.T, h http.Handler, p *oidctest.Provider, returnTo string) *httptest.ResponseRecorder {
	t.Helper()
	rec := do(t, h, "GET", "/auth/oidc/login?return="+url.QueryEscape(returnTo), "", nil)
	if rec.Code != http.StatusFound || !strings.HasPrefix(rec.Header().Get("Location"), p.URL+"/auth?") {
		t.Fatalf("login: status %d, Location %q", rec.Code, rec.Header().Get("Location"))
	}
	var state *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == oidcStateCookie {
			state = c
		}
	}
	if state == nil || !state.HttpOnly || state.SameSite != http.SameSiteLaxMode || state.Path != "/auth/oidc" {
		t.Fatalf("cookie de state: %+v", state)
	}
	back, _ := url.Parse(p.Authorize(t, rec.Header().Get("Location")))
	return do(t, h, "GET", back.RequestURI(), "", map[string]string{"Cookie": state.Name + "=" + state.Value})
}

func TestOIDCImpersonateLogin(t *testing.T) {
	p := oidctest.New(t)
	var got http.Header
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	defer api.Close()
	fc := newFakeCluster()
	fc.mode = cluster.ModeInCluster
	fc.host = api.URL
	h := newOIDCServer(t, p, fc, auth.OIDCImpersonate, oidcWhoAmI)

	if s := sessionOf(t, h, ""); s.Authenticated || !slices.Equal(s.LoginMethods, []string{"oidc", "token"}) || s.OIDCName != "Dex" {
		t.Fatalf("antes do login: %+v", s)
	}

	rec := oidcLoginFlow(t, h, p, "/pods?ns=demo")
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/pods?ns=demo" {
		t.Fatalf("retorno: status %d, Location %q", rec.Code, rec.Header().Get("Location"))
	}
	c, cookie := cookieFrom(t, rec)
	if c.SameSite != http.SameSiteStrictMode || !c.HttpOnly {
		t.Errorf("cookie de sessão: %+v", c)
	}
	s := sessionOf(t, h, cookie)
	if !s.Authenticated || s.User == nil || s.User.Username != "oidc:ana@exemplo.com" || !slices.Equal(s.User.Groups, []string{"oidc:dev"}) {
		t.Fatalf("sessão: %+v", s)
	}

	// O proxy fala com a API como o KubeViz agindo pelo usuário; cabeçalhos
	// de impersonation vindos do navegador não passam.
	rec = do(t, h, "GET", "/api/k8s/api/v1/pods", "", map[string]string{"Cookie": cookie, "Impersonate-User": "system:admin", "Impersonate-Group": "system:masters"})
	if rec.Code != 200 {
		t.Fatalf("proxy: %d %s", rec.Code, rec.Body)
	}
	if got.Get("Authorization") != "Bearer kubeconfig-token" || got.Get("Impersonate-User") != "oidc:ana@exemplo.com" ||
		!slices.Equal(got.Values("Impersonate-Group"), []string{"oidc:dev"}) {
		t.Errorf("cabeçalhos no API server: %v", got)
	}
}

func TestOIDCLoginFailures(t *testing.T) {
	p := oidctest.New(t)
	h := newOIDCServer(t, p, newFakeCluster(), auth.OIDCImpersonate, oidcWhoAmI)
	failed := func(rec *httptest.ResponseRecorder, code string) {
		t.Helper()
		if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/?loginError="+code {
			t.Errorf("quer %s: status %d, Location %q", code, rec.Code, rec.Header().Get("Location"))
		}
		for _, c := range rec.Result().Cookies() {
			if c.Name == sessionCookie && c.MaxAge >= 0 {
				t.Errorf("%s abriu sessão", code)
			}
		}
	}

	// O provedor recusou (pessoa cancelou, sem acesso ao aplicativo...).
	failed(do(t, h, "GET", "/auth/oidc/callback?error=access_denied&state=x", "", nil), "oidc_denied")

	// Retorno sem o cookie de state (link de outra pessoa: login CSRF).
	rec := do(t, h, "GET", "/auth/oidc/login", "", nil)
	back, _ := url.Parse(p.Authorize(t, rec.Header().Get("Location")))
	failed(do(t, h, "GET", back.RequestURI(), "", nil), "oidc_state")

	// Sem permissão de impersonation para o KubeViz.
	forbidden := func(context.Context, *rest.Config) (auth.User, error) {
		return auth.User{}, apierrors.NewForbidden(schema.GroupResource{Resource: "users"}, "oidc:ana", nil)
	}
	failed(oidcLoginFlow(t, newOIDCServer(t, p, newFakeCluster(), auth.OIDCImpersonate, forbidden), p, "/"), "oidc_impersonate")

	// Modo token com um API server que não confia no provedor.
	rejected := func(context.Context, *rest.Config) (auth.User, error) { return auth.User{}, auth.ErrInvalidCredentials }
	failed(oidcLoginFlow(t, newOIDCServer(t, p, newFakeCluster(), auth.OIDCToken, rejected), p, "/"), "oidc_cluster")

	// O retorno nunca leva a outro site.
	rec = oidcLoginFlow(t, h, p, "//evil.example/x")
	if rec.Header().Get("Location") != "/" {
		t.Errorf("redirecionamento aberto: %q", rec.Header().Get("Location"))
	}
}

func TestOIDCTokenModeAndRefresh(t *testing.T) {
	p := oidctest.New(t)
	// ID tokens de 30 s: todo uso da sessão renova o login.
	p.TTL = 30 * time.Second
	var auths []string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auths = append(auths, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{}`))
	}))
	defer api.Close()
	fc := newFakeCluster()
	fc.mode = cluster.ModeInCluster
	fc.host = api.URL
	h := newOIDCServer(t, p, fc, auth.OIDCToken, oidcWhoAmI)

	_, cookie := cookieFrom(t, oidcLoginFlow(t, h, p, "/"))
	// No modo token, a identidade é a que o API server reconhece.
	if s := sessionOf(t, h, cookie); s.User == nil || s.User.Username != "https://idp#ana" {
		t.Fatalf("sessão: %+v", s)
	}
	for range 2 {
		if rec := do(t, h, "GET", "/api/k8s/version", "", map[string]string{"Cookie": cookie}); rec.Code != 200 {
			t.Fatalf("proxy: %d", rec.Code)
		}
	}
	if len(auths) != 2 || !strings.HasPrefix(auths[0], "Bearer eyJ") || auths[0] == auths[1] {
		t.Errorf("o ID token renovado deveria ser repassado: %v", auths)
	}
	if p.RefreshCount() < 2 {
		t.Errorf("renovações: %d", p.RefreshCount())
	}

	// Acesso revogado no provedor: a sessão acaba.
	p.Set(func(p *oidctest.Provider) { p.RefreshFails = true })
	if rec := do(t, h, "GET", "/api/v1/cluster", "", map[string]string{"Cookie": cookie}); rec.Code != 401 {
		t.Errorf("após revogação: status %d, quer 401", rec.Code)
	}
}

func TestSafeReturnPath(t *testing.T) {
	for in, want := range map[string]string{
		"/pods?ns=demo": "/pods?ns=demo", "": "/", "https://evil.example": "/", "//evil.example": "/",
		"/\\evil.example": "/", "pods": "/", "/a\r\nSet-Cookie: x": "/",
	} {
		if got := safeReturnPath(in); got != want {
			t.Errorf("safeReturnPath(%q) = %q, quer %q", in, got, want)
		}
	}
}
