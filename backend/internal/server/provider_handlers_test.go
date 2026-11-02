package server

import (
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/auth/oidctest"
)

func TestProviderLogin(t *testing.T) {
	p := oidctest.New(t)
	users := auth.NewUsers(filepath.Join(t.TempDir(), "users"))
	h := New(slog.New(slog.DiscardHandler), testAssets, newFakeCluster(), Options{Users: users, Providers: auth.NewProviders(), WhoAmI: fakeWhoAmI}).Handler()
	_, admin := setupAccount(t, h, "fabio", testPassword)
	as := with(jsonHeaders, "Cookie", admin)

	// O administrador configura um provedor OIDC pela interface.
	cfg := `{"type":"oidc","name":"Dex","issuerUrl":"` + p.URL + `","clientId":"` + oidctest.ClientID + `","clientSecret":"` + oidctest.ClientSecret + `"}`
	if rec := do(t, h, "PUT", "/api/v1/admin/providers/dex", cfg, as); rec.Code != 204 {
		t.Fatalf("salvar provedor: %d %s", rec.Code, rec.Body)
	}
	rec := do(t, h, "GET", "/api/v1/admin/providers", "", as)
	if strings.Contains(rec.Body.String(), oidctest.ClientSecret) || !strings.Contains(rec.Body.String(), `"hasSecret":true`) {
		t.Fatalf("a interface não pode receber o secret: %s", rec.Body)
	}
	// Alterar sem reenviar o secret mantém o atual.
	if rec := do(t, h, "PUT", "/api/v1/admin/providers/dex", strings.Replace(cfg, oidctest.ClientSecret, "", 1), as); rec.Code != 204 {
		t.Fatalf("alterar sem secret: %d %s", rec.Code, rec.Body)
	}
	if s := sessionOf(t, h, ""); len(s.Providers) != 1 || s.Providers[0].ID != "dex" || s.Providers[0].Name != "Dex" {
		t.Fatalf("botões da tela de login: %+v", s.Providers)
	}

	flow := func() *httpResult {
		t.Helper()
		rec := do(t, h, "GET", "/auth/provider/dex/login?return=%2Fpods", "", nil)
		if rec.Code != http.StatusFound {
			t.Fatalf("login: %d", rec.Code)
		}
		var state string
		for _, c := range rec.Result().Cookies() {
			if c.Name == providerStateCookie {
				state = c.Value
			}
		}
		loc := rec.Header().Get("Location")
		if q, _ := url.Parse(loc); q.Query().Get("redirect_uri") != "http://127.0.0.1:4466/auth/provider/dex/callback" {
			t.Fatalf("endereço de retorno: %s", loc)
		}
		back, _ := url.Parse(p.Authorize(t, loc))
		rec = do(t, h, "GET", back.RequestURI(), "", map[string]string{"Cookie": providerStateCookie + "=" + state})
		res := &httpResult{location: rec.Header().Get("Location")}
		for _, c := range rec.Result().Cookies() {
			if c.Name == sessionCookie && c.MaxAge >= 0 {
				res.cookie = c.Name + "=" + c.Value
			}
		}
		return res
	}

	// E-mail sem conta: recusado.
	if r := flow(); r.location != "/?loginError=provider_unauthorized" || r.cookie != "" {
		t.Fatalf("sem conta: %+v", r)
	}
	// Com uma conta que tem o e-mail: entra nela.
	if rec := do(t, h, "POST", "/api/v1/admin/users", `{"name":"ana","emails":["ana@exemplo.com"]}`, as); rec.Code != 201 {
		t.Fatalf("criar ana: %d", rec.Code)
	}
	r := flow()
	if r.location != "/pods" || r.cookie == "" {
		t.Fatalf("com conta: %+v", r)
	}
	if s := sessionOf(t, h, r.cookie); s.LocalUser != "ana" || s.Admin {
		t.Errorf("sessão da ana: %+v", s)
	}
	// Domínio liberado: quem ainda não tem conta ganha uma no primeiro acesso.
	p.Set(func(p *oidctest.Provider) { p.Claims["email"] = "bia.lima@exemplo.com" })
	if rec := do(t, h, "PUT", "/api/v1/admin/domains", `{"domains":["exemplo.com"]}`, as); rec.Code != 204 {
		t.Fatal(rec.Code)
	}
	if r := flow(); r.cookie == "" {
		t.Fatalf("domínio liberado: %+v", r)
	} else if s := sessionOf(t, h, r.cookie); s.LocalUser != "bia.lima" {
		t.Errorf("conta criada: %+v", s)
	}
	// E-mail não verificado: recusado mesmo com conta.
	p.Set(func(p *oidctest.Provider) { p.Claims["email"] = "ana@exemplo.com"; p.Claims["email_verified"] = false })
	if r := flow(); r.location != "/?loginError=provider_email" {
		t.Errorf("não verificado: %+v", r)
	}
	// Quem não é administrador não vê nem altera provedores.
	if rec := do(t, h, "GET", "/api/v1/admin/providers", "", map[string]string{"Cookie": r.cookie}); rec.Code != 401 && rec.Code != 403 {
		t.Errorf("não admin: %d", rec.Code)
	}
	if rec := do(t, h, "DELETE", "/api/v1/admin/providers/dex", "", as); rec.Code != 204 {
		t.Errorf("remover: %d", rec.Code)
	}
	if rec := do(t, h, "GET", "/auth/provider/dex/login", "", nil); rec.Code != 404 {
		t.Errorf("provedor removido: %d", rec.Code)
	}
}

type httpResult struct{ location, cookie string }
