package auth_test

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/auth/oidctest"
)

func newOIDC(t *testing.T, p *oidctest.Provider, mode auth.OIDCMode, prefix string) *auth.OIDC {
	t.Helper()
	o, err := auth.NewOIDC(auth.OIDCConfig{
		IssuerURL: p.URL, ClientID: oidctest.ClientID, ClientSecret: oidctest.ClientSecret,
		RedirectURL: "http://127.0.0.1:4466/auth/oidc/callback", Scopes: []string{"openid", "email"},
		UsernameClaim: "email", GroupsClaim: "groups", UsernamePrefix: prefix, GroupsPrefix: prefix, Mode: mode,
	})
	if err != nil {
		t.Fatal(err)
	}
	return o
}

// login faz o fluxo completo e devolve o resultado da troca do código.
func login(t *testing.T, p *oidctest.Provider, o *auth.OIDC) (auth.User, *auth.OIDCTokens, string, error) {
	t.Helper()
	authURL, state, err := o.AuthURL(context.Background(), "/pods")
	if err != nil {
		t.Fatal(err)
	}
	back, _ := url.Parse(p.Authorize(t, authURL))
	return o.Exchange(context.Background(), back.Query().Get("state"), state, back.Query().Get("code"))
}

func TestOIDCImpersonateIdentity(t *testing.T) {
	p := oidctest.New(t)
	p.Claims["groups"] = []string{"dev", "system:masters"}
	user, tokens, returnTo, err := login(t, p, newOIDC(t, p, auth.OIDCImpersonate, "oidc:"))
	if err != nil {
		t.Fatal(err)
	}
	if user.Username != "oidc:ana@exemplo.com" || !slices.Equal(user.Groups, []string{"oidc:dev", "oidc:system:masters"}) {
		t.Errorf("identidade: %+v", user)
	}
	if returnTo != "/pods" || tokens.IDToken == "" || tokens.RefreshToken == "" || tokens.Subject != "u-123" {
		t.Errorf("retorno %q, tokens %+v", returnTo, tokens)
	}

	// Sem prefixo, grupos reservados do cluster são descartados.
	user, _, _, err = login(t, p, newOIDC(t, p, auth.OIDCImpersonate, ""))
	if err != nil || user.Username != "ana@exemplo.com" || !slices.Equal(user.Groups, []string{"dev"}) {
		t.Errorf("sem prefixo: %+v, %v", user, err)
	}

	// E ninguém vira um usuário system:*.
	p.Claims["email"] = "system:admin"
	if _, _, _, err := login(t, p, newOIDC(t, p, auth.OIDCImpersonate, "")); !errors.Is(err, auth.ErrOIDCClaims) {
		t.Errorf("system:admin aceito: %v", err)
	}
}

func TestOIDCTokenModeKeepsClaims(t *testing.T) {
	p := oidctest.New(t)
	user, _, _, err := login(t, p, newOIDC(t, p, auth.OIDCToken, "oidc:"))
	if err != nil || user.Username != "ana@exemplo.com" {
		t.Errorf("modo token: %+v, %v", user, err)
	}
}

func TestOIDCRejectsBadLogins(t *testing.T) {
	p := oidctest.New(t)
	o := newOIDC(t, p, auth.OIDCImpersonate, "oidc:")
	ctx := context.Background()

	// State diferente do cookie (login iniciado em outro navegador).
	authURL, state, _ := o.AuthURL(ctx, "/")
	back, _ := url.Parse(p.Authorize(t, authURL))
	if _, _, _, err := o.Exchange(ctx, back.Query().Get("state"), "outro", back.Query().Get("code")); !errors.Is(err, auth.ErrOIDCState) {
		t.Errorf("state trocado: %v", err)
	}
	// O link forjado não estraga o login legítimo, que funciona uma vez só.
	if _, _, _, err := o.Exchange(ctx, state, state, back.Query().Get("code")); err != nil {
		t.Errorf("login legítimo: %v", err)
	}
	if _, _, _, err := o.Exchange(ctx, state, state, back.Query().Get("code")); !errors.Is(err, auth.ErrOIDCState) {
		t.Errorf("state reutilizado: %v", err)
	}

	// Código inválido.
	authURL, state, _ = o.AuthURL(ctx, "/")
	p.Authorize(t, authURL)
	if _, _, _, err := o.Exchange(ctx, state, state, "inventado"); err == nil {
		t.Error("código inventado aceito")
	}

	// E-mail não verificado não serve de nome de usuário.
	p.Claims["email_verified"] = false
	if _, _, _, err := login(t, p, o); !errors.Is(err, auth.ErrOIDCClaims) {
		t.Errorf("e-mail não verificado: %v", err)
	}
	p.Claims["email_verified"] = true
	delete(p.Claims, "email")
	if _, _, _, err := login(t, p, o); !errors.Is(err, auth.ErrOIDCClaims) {
		t.Errorf("sem e-mail: %v", err)
	}
}

func TestOIDCFresh(t *testing.T) {
	p := oidctest.New(t)
	o := newOIDC(t, p, auth.OIDCImpersonate, "oidc:")
	ctx := context.Background()

	// Token longe de vencer: nada a fazer.
	_, tokens, _, err := login(t, p, o)
	if err != nil {
		t.Fatal(err)
	}
	if tok, err := o.Fresh(ctx, tokens); err != nil || tok != tokens.IDToken || p.RefreshCount() != 0 {
		t.Fatalf("token novo: %v, renovações %d", err, p.RefreshCount())
	}

	// Perto de vencer: renova com o refresh token.
	tokens.Expiry = time.Now().Add(10 * time.Second)
	old := tokens.IDToken
	if tok, err := o.Fresh(ctx, tokens); err != nil || tok == old || p.RefreshCount() != 1 {
		t.Fatalf("renovação: %v, renovações %d", err, p.RefreshCount())
	}

	// Outra pessoa na renovação: recusado.
	tokens.Expiry = time.Now()
	p.Set(func(p *oidctest.Provider) { p.Claims["sub"] = "u-999" })
	if _, err := o.Fresh(ctx, tokens); err == nil {
		t.Error("renovação com outro sub aceita")
	}

	// Acesso revogado no provedor.
	p.Set(func(p *oidctest.Provider) { p.Claims["sub"] = "u-123"; p.RefreshFails = true })
	if _, err := o.Fresh(ctx, tokens); err == nil {
		t.Error("renovação recusada pelo provedor não encerrou o login")
	}

	// Sem refresh token, vale até o ID token vencer.
	expired := &auth.OIDCTokens{IDToken: "x", Expiry: time.Now().Add(-time.Second)}
	if _, err := o.Fresh(ctx, expired); err == nil {
		t.Error("token vencido sem renovação aceito")
	}
	valid := &auth.OIDCTokens{IDToken: "x", Expiry: time.Now().Add(30 * time.Second)}
	if tok, err := o.Fresh(ctx, valid); err != nil || tok != "x" {
		t.Errorf("token ainda válido sem refresh: %q %v", tok, err)
	}
}
