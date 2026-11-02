package auth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// OIDCMode define como a identidade vinda do provedor chega ao cluster.
type OIDCMode string

const (
	// OIDCImpersonate: o KubeViz fala com a API usando a própria credencial e
	// os cabeçalhos Impersonate-User/Group. Funciona sem configurar o API
	// server; a credencial do KubeViz precisa da permissão "impersonate".
	OIDCImpersonate OIDCMode = "impersonate"
	// OIDCToken: o ID token do usuário é repassado à API. Exige um API server
	// que confie no provedor (--oidc-issuer-url ou AuthenticationConfiguration).
	OIDCToken OIDCMode = "token"
)

// OIDCConfig descreve o provedor de identidade e como usar o que ele informa.
type OIDCConfig struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string
	// RedirectURL é o endereço público de /auth/oidc/callback.
	RedirectURL string
	Scopes      []string
	// UsernameClaim e GroupsClaim são os campos do ID token com o nome do
	// usuário e os grupos.
	UsernameClaim string
	GroupsClaim   string
	// UsernamePrefix e GroupsPrefix são acrescentados no modo impersonate,
	// como faz o API server, para que ninguém do provedor se passe por um
	// usuário ou grupo do próprio cluster.
	UsernamePrefix string
	GroupsPrefix   string
	Mode           OIDCMode
	// CAFile é a CA do provedor, se não for uma CA pública.
	CAFile string
	// DisplayName aparece no botão da tela de login (ex.: "Keycloak").
	DisplayName string
}

// OIDCTokens são as credenciais do provedor guardadas na sessão (nunca vão
// ao navegador).
type OIDCTokens struct {
	mu           sync.Mutex
	IDToken      string
	RefreshToken string
	// Expiry é a validade do ID token.
	Expiry time.Time
	// Subject identifica a pessoa no provedor; não pode mudar na renovação.
	Subject string
}

// Token devolve o ID token atual (renovado por Fresh).
func (t *OIDCTokens) Token() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.IDToken
}

// Erros do login OIDC.
var (
	ErrOIDCState  = errors.New("login expirado ou iniciado em outra aba; tente de novo")
	ErrOIDCClaims = errors.New("o provedor não informou o nome do usuário")
)

// OIDC conversa com o provedor de identidade. A descoberta do provedor é
// feita no primeiro uso (e refeita se falhar), para que o KubeViz suba mesmo
// com o provedor fora do ar.
type OIDC struct {
	cfg    OIDCConfig
	client *http.Client
	now    func() time.Time

	mu       sync.Mutex
	provider *oidc.Provider
	pending  map[string]pendingLogin
}

// pendingLogin é um login iniciado e ainda não concluído.
type pendingLogin struct {
	verifier string
	nonce    string
	returnTo string
	expires  time.Time
}

// pendingTTL é quanto tempo a pessoa tem para concluir o login no provedor.
const pendingTTL = 10 * time.Minute

// NewOIDC prepara o cliente; não acessa a rede.
func NewOIDC(cfg OIDCConfig) (*OIDC, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("lendo a CA do provedor OIDC: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("nenhum certificado em %s", cfg.CAFile)
		}
		client.Transport = &http.Transport{
			Proxy:           http.ProxyFromEnvironment,
			TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		}
	}
	return &OIDC{cfg: cfg, client: client, now: time.Now, pending: map[string]pendingLogin{}}, nil
}

// Config devolve a configuração.
func (o *OIDC) Config() OIDCConfig { return o.cfg }

func (o *OIDC) ctx(ctx context.Context) context.Context {
	return oidc.ClientContext(ctx, o.client)
}

func (o *OIDC) providerFor(ctx context.Context) (*oidc.Provider, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.provider != nil {
		return o.provider, nil
	}
	p, err := oidc.NewProvider(o.ctx(ctx), o.cfg.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("provedor OIDC inacessível: %w", err)
	}
	o.provider = p
	return p, nil
}

func (o *OIDC) oauth2Config(p *oidc.Provider) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     o.cfg.ClientID,
		ClientSecret: o.cfg.ClientSecret,
		RedirectURL:  o.cfg.RedirectURL,
		Endpoint:     p.Endpoint(),
		Scopes:       o.cfg.Scopes,
	}
}

// AuthURL inicia um login: devolve o endereço do provedor e o state, que o
// servidor guarda num cookie do navegador para conferir na volta.
func (o *OIDC) AuthURL(ctx context.Context, returnTo string) (authURL, state string, err error) {
	p, err := o.providerFor(ctx)
	if err != nil {
		return "", "", err
	}
	state, nonce, verifier := RandomToken(), RandomToken(), oauth2.GenerateVerifier()

	o.mu.Lock()
	now := o.now()
	for k, v := range o.pending {
		if now.After(v.expires) {
			delete(o.pending, k)
		}
	}
	o.pending[state] = pendingLogin{verifier: verifier, nonce: nonce, returnTo: returnTo, expires: now.Add(pendingTTL)}
	o.mu.Unlock()

	return o.oauth2Config(p).AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), state, nil
}

// Exchange conclui o login: confere o state (que precisa ser o mesmo do
// cookie), troca o código pelos tokens com PKCE e valida o ID token.
// Devolve a identidade, os tokens e o endereço para onde voltar.
func (o *OIDC) Exchange(ctx context.Context, state, cookieState, code string) (User, *OIDCTokens, string, error) {
	if state == "" || !Equal(state, cookieState) {
		return User{}, nil, "", ErrOIDCState
	}
	o.mu.Lock()
	pl, ok := o.pending[state]
	delete(o.pending, state) // uso único
	o.mu.Unlock()
	if !ok || o.now().After(pl.expires) {
		return User{}, nil, "", ErrOIDCState
	}

	p, err := o.providerFor(ctx)
	if err != nil {
		return User{}, nil, "", err
	}
	tok, err := o.oauth2Config(p).Exchange(o.ctx(ctx), code, oauth2.VerifierOption(pl.verifier))
	if err != nil {
		return User{}, nil, "", fmt.Errorf("trocando o código no provedor: %w", err)
	}
	tokens, idt, err := o.verify(ctx, p, tok)
	if err != nil {
		return User{}, nil, "", err
	}
	if idt.Nonce == "" || !Equal(idt.Nonce, pl.nonce) {
		return User{}, nil, "", errors.New("ID token com nonce inválido")
	}
	user, err := o.identity(idt)
	if err != nil {
		return User{}, nil, "", err
	}
	return user, tokens, pl.returnTo, nil
}

// verify valida o ID token recebido do provedor.
func (o *OIDC) verify(ctx context.Context, p *oidc.Provider, tok *oauth2.Token) (*OIDCTokens, *oidc.IDToken, error) {
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		return nil, nil, errors.New("o provedor não devolveu um ID token (o escopo openid está nos escopos?)")
	}
	idt, err := p.VerifierContext(o.ctx(ctx), &oidc.Config{ClientID: o.cfg.ClientID, Now: o.now}).Verify(o.ctx(ctx), raw)
	if err != nil {
		return nil, nil, fmt.Errorf("ID token inválido: %w", err)
	}
	return &OIDCTokens{IDToken: raw, RefreshToken: tok.RefreshToken, Expiry: idt.Expiry, Subject: idt.Subject}, idt, nil
}

// identity lê o usuário e os grupos do ID token. No modo impersonate aplica
// os prefixos e descarta grupos reservados do cluster (system:*).
func (o *OIDC) identity(idt *oidc.IDToken) (User, error) {
	var claims map[string]any
	if err := idt.Claims(&claims); err != nil {
		return User{}, fmt.Errorf("lendo o ID token: %w", err)
	}
	name, _ := claims[o.cfg.UsernameClaim].(string)
	if name == "" {
		return User{}, fmt.Errorf("%w (campo %q ausente no ID token)", ErrOIDCClaims, o.cfg.UsernameClaim)
	}
	// Como o API server: e-mail só vale se verificado.
	if o.cfg.UsernameClaim == "email" {
		if v, ok := claims["email_verified"].(bool); ok && !v {
			return User{}, fmt.Errorf("%w (e-mail %s não verificado no provedor)", ErrOIDCClaims, name)
		}
	}
	var groups []string
	switch g := claims[o.cfg.GroupsClaim].(type) {
	case string:
		groups = []string{g}
	case []any:
		for _, v := range g {
			if s, ok := v.(string); ok {
				groups = append(groups, s)
			}
		}
	}
	if o.cfg.Mode != OIDCImpersonate {
		return User{Username: name, Groups: groups}, nil
	}

	user := User{Username: o.cfg.UsernamePrefix + name}
	for _, g := range groups {
		if g = o.cfg.GroupsPrefix + g; !strings.HasPrefix(g, "system:") {
			user.Groups = append(user.Groups, g)
		}
	}
	if strings.HasPrefix(user.Username, "system:") {
		return User{}, fmt.Errorf("%w (nome reservado do cluster: %s)", ErrOIDCClaims, user.Username)
	}
	return user, nil
}

// refreshMargin: o ID token é renovado um pouco antes de vencer.
const refreshMargin = time.Minute

// Fresh garante que os tokens da sessão continuam válidos, renovando-os com o
// refresh token quando perto de vencer. Um erro significa que a sessão acabou
// (token vencido sem renovação, ou acesso revogado no provedor).
func (o *OIDC) Fresh(ctx context.Context, t *OIDCTokens) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if o.now().Add(refreshMargin).Before(t.Expiry) {
		return t.IDToken, nil
	}
	if t.RefreshToken == "" {
		if o.now().Before(t.Expiry) {
			return t.IDToken, nil
		}
		return "", errors.New("login expirado")
	}
	p, err := o.providerFor(ctx)
	if err != nil {
		return "", err
	}
	src := o.oauth2Config(p).TokenSource(o.ctx(ctx), &oauth2.Token{RefreshToken: t.RefreshToken, Expiry: o.now().Add(-time.Second)})
	tok, err := src.Token()
	if err != nil {
		return "", fmt.Errorf("renovando o login: %w", err)
	}
	fresh, _, err := o.verify(ctx, p, tok)
	if err != nil {
		return "", err
	}
	if fresh.Subject != t.Subject {
		return "", errors.New("o provedor renovou o login de outra pessoa")
	}
	t.IDToken, t.Expiry = fresh.IDToken, fresh.Expiry
	if fresh.RefreshToken != "" {
		t.RefreshToken = fresh.RefreshToken
	}
	return t.IDToken, nil
}
