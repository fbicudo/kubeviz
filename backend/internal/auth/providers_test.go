package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestProviderConfigNormalize(t *testing.T) {
	ok := func(p ProviderConfig) ProviderConfig {
		t.Helper()
		out, err := p.Normalize()
		if err != nil {
			t.Fatalf("%+v: %v", p, err)
		}
		return out
	}
	if g := ok(ProviderConfig{Type: "Google", ClientID: " id ", ClientSecret: "s", IssuerURL: "https://ignorado"}); g.ID != "google" || g.Name != "Google" || g.ClientID != "id" || g.IssuerURL != "" {
		t.Errorf("google: %+v", g)
	}
	if m := ok(ProviderConfig{Type: "microsoft", ClientID: "id", ClientSecret: "s"}); m.Tenant != "common" || m.ID != "microsoft" {
		t.Errorf("microsoft: %+v", m)
	}
	if o := ok(ProviderConfig{Type: "oidc", ID: "Keycloak", ClientID: "id", ClientSecret: "s", IssuerURL: "https://kc.exemplo.com/realms/x"}); o.ID != "keycloak" || o.Name != "OIDC" {
		t.Errorf("oidc: %+v", o)
	}
	for name, p := range map[string]ProviderConfig{
		"tipo desconhecido":  {Type: "facebook", ClientID: "id", ClientSecret: "s"},
		"sem secret":         {Type: "google", ClientID: "id"},
		"oidc sem https":     {Type: "oidc", ID: "x", ClientID: "id", ClientSecret: "s", IssuerURL: "http://idp.exemplo.com"},
		"oidc com id google": {Type: "oidc", ID: "google", ClientID: "id", ClientSecret: "s", IssuerURL: "https://idp"},
		"inquilino inválido": {Type: "microsoft", ClientID: "id", ClientSecret: "s", Tenant: "empresa.com"},
	} {
		if _, err := p.Normalize(); !errors.Is(err, ErrProviderConfig) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestMicrosoftIdentity(t *testing.T) {
	const org = "11111111-2222-3333-4444-555555555555"
	iss := func(tid string) string { return microsoftLogin + "/" + tid + "/v2.0" }
	common := ProviderConfig{Type: ProviderMicrosoft, Tenant: "common"}

	// Conta pessoal: e-mail, verificado pela Microsoft.
	if e, err := microsoftEmail(common, iss(microsoftConsumers), map[string]any{"tid": microsoftConsumers, "email": "ana@outlook.com"}); err != nil || e != "ana@outlook.com" {
		t.Errorf("pessoal: %q %v", e, err)
	}
	// Organização: o nome de login (domínio verificado), nunca o campo email.
	claims := map[string]any{"tid": org, "email": "ceo@banco.com", "preferred_username": "ana@empresa.com"}
	if e, err := microsoftEmail(common, iss(org), claims); err != nil || e != "ana@empresa.com" {
		t.Errorf("organização: %q %v", e, err)
	}
	// Convidado de outra organização (#EXT#) e emissor que não bate com o inquilino.
	if _, err := microsoftEmail(common, iss(org), map[string]any{"tid": org, "preferred_username": "ana_x.com#EXT#@empresa.onmicrosoft.com"}); err == nil {
		t.Error("convidado #EXT# aceito")
	}
	if _, err := microsoftEmail(common, iss("outro"), claims); err == nil {
		t.Error("emissor de outro inquilino aceito")
	}
	// Restrições de inquilino.
	if _, err := microsoftEmail(ProviderConfig{Tenant: "consumers"}, iss(org), claims); err == nil {
		t.Error("organização aceita em consumers")
	}
	if _, err := microsoftEmail(ProviderConfig{Tenant: "99999999-2222-3333-4444-555555555555"}, iss(org), claims); err == nil {
		t.Error("outra organização aceita")
	}
	if _, err := microsoftEmail(ProviderConfig{Tenant: org}, iss(org), claims); err != nil {
		t.Errorf("a própria organização: %v", err)
	}
}

func TestVerifiedEmail(t *testing.T) {
	if _, err := verifiedEmail(map[string]any{"email": "a@b.com"}); !errors.Is(err, ErrUnverifiedEmail) {
		t.Errorf("sem email_verified: %v", err)
	}
	if e, err := verifiedEmail(map[string]any{"email": "a@b.com", "email_verified": true}); err != nil || e != "a@b.com" {
		t.Errorf("verificado: %q %v", e, err)
	}
}

func TestGitHubLogin(t *testing.T) {
	var verified = true
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.PostForm.Get("code") != "codigo" || r.PostForm.Get("client_secret") != "segredo" || r.PostForm.Get("code_verifier") == "" {
			http.Error(w, "bad", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"gho_teste","token_type":"bearer"}`))
	})
	mux.HandleFunc("GET /user/emails", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gho_teste" {
			http.Error(w, "no", 401)
			return
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"email": "outro@x.com", "primary": false, "verified": true},
			{"email": "Ana@Exemplo.com", "primary": true, "verified": verified},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	oldAuth, oldToken, oldAPI := githubAuthURL, githubTokenURL, githubAPI
	githubAuthURL, githubTokenURL, githubAPI = srv.URL+"/login/oauth/authorize", srv.URL+"/login/oauth/access_token", srv.URL
	defer func() { githubAuthURL, githubTokenURL, githubAPI = oldAuth, oldToken, oldAPI }()

	p, _ := ProviderConfig{Type: ProviderGitHub, ClientID: "id", ClientSecret: "segredo"}.Normalize()
	ps := NewProviders()
	login := func() (string, error) {
		authURL, state, err := ps.AuthURL(context.Background(), p, "http://127.0.0.1:4466/auth/provider/github/callback", "/pods")
		if err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(authURL)
		if u.Query().Get("scope") != "read:user user:email" || u.Query().Get("code_challenge_method") != "S256" {
			t.Fatalf("pedido ao GitHub: %s", authURL)
		}
		email, returnTo, err := ps.Identify(context.Background(), p, state, state, "codigo")
		if err == nil && returnTo != "/pods" {
			t.Errorf("retorno %q", returnTo)
		}
		return email, err
	}
	if email, err := login(); err != nil || email != "ana@exemplo.com" {
		t.Fatalf("GitHub: %q %v", email, err)
	}
	verified = false
	if _, err := login(); !errors.Is(err, ErrUnverifiedEmail) {
		t.Errorf("e-mail principal não verificado: %v", err)
	}
}
