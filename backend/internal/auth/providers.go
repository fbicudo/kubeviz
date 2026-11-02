package auth

// Provedores de identidade das contas locais (Google, Microsoft, GitHub ou
// qualquer OIDC). Eles só confirmam o e-mail de quem entra; quem tem acesso é
// decidido pelas contas e domínios liberados (ver Users.ForEmail). A sessão é
// da conta local: nenhum token do provedor é guardado.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Tipos de provedor.
const (
	ProviderGoogle    = "google"
	ProviderMicrosoft = "microsoft"
	ProviderGitHub    = "github"
	ProviderOIDC      = "oidc"
)

// Erros do login por provedor.
var (
	ErrUnverifiedEmail = errors.New("o provedor não confirmou um e-mail verificado")
	ErrProviderConfig  = errors.New("configuração de provedor inválida")
)

// microsoftConsumers é o inquilino das contas pessoais da Microsoft
// (outlook.com, hotmail.com…), cujos e-mails a Microsoft verifica.
const microsoftConsumers = "9188040d-6c67-4c5b-b112-36a304b66dad"

// Endereços dos provedores; variáveis para os testes apontarem para servidores falsos.
var (
	googleIssuer    = "https://accounts.google.com"
	microsoftLogin  = "https://login.microsoftonline.com"
	githubAuthURL   = "https://github.com/login/oauth/authorize"
	githubTokenURL  = "https://github.com/login/oauth/access_token"
	githubAPI       = "https://api.github.com"
	validProviderID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	// Inquilino da Microsoft: common, organizations, consumers ou o ID de uma organização.
	validTenant       = regexp.MustCompile(`^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)
	providerHTTPLimit = 15 * time.Second
)

// ProviderDefaults: nome exibido de cada tipo.
var providerNames = map[string]string{
	ProviderGoogle: "Google", ProviderMicrosoft: "Microsoft", ProviderGitHub: "GitHub", ProviderOIDC: "OIDC",
}

// Normalize valida e completa a configuração (ID, nome, inquilino).
func (p ProviderConfig) Normalize() (ProviderConfig, error) {
	p.Type = strings.ToLower(strings.TrimSpace(p.Type))
	p.ClientID = strings.TrimSpace(p.ClientID)
	p.ClientSecret = strings.TrimSpace(p.ClientSecret)
	p.Name = strings.TrimSpace(p.Name)
	if _, ok := providerNames[p.Type]; !ok {
		return p, fmt.Errorf("%w: tipo %q (use google, microsoft, github ou oidc)", ErrProviderConfig, p.Type)
	}
	if p.ClientID == "" || p.ClientSecret == "" {
		return p, fmt.Errorf("%w: informe o client ID e o client secret", ErrProviderConfig)
	}
	if p.Type != ProviderOIDC {
		p.ID = p.Type
	}
	if p.Name == "" {
		p.Name = providerNames[p.Type]
	}
	switch p.Type {
	case ProviderOIDC:
		p.ID = strings.ToLower(strings.TrimSpace(p.ID))
		if !validProviderID.MatchString(p.ID) || slices.Contains([]string{ProviderGoogle, ProviderMicrosoft, ProviderGitHub}, p.ID) {
			return p, fmt.Errorf("%w: identificador %q (letras minúsculas, números e hífen)", ErrProviderConfig, p.ID)
		}
		if !strings.HasPrefix(p.IssuerURL, "https://") && !strings.HasPrefix(p.IssuerURL, "http://127.0.0.1") && !strings.HasPrefix(p.IssuerURL, "http://localhost") {
			return p, fmt.Errorf("%w: o endereço do provedor precisa usar https", ErrProviderConfig)
		}
	case ProviderMicrosoft:
		if p.Tenant == "" {
			p.Tenant = "common"
		}
		p.Tenant = strings.ToLower(strings.TrimSpace(p.Tenant))
		if !validTenant.MatchString(p.Tenant) {
			return p, fmt.Errorf("%w: inquilino %q (use common, organizations, consumers ou o ID da organização)", ErrProviderConfig, p.Tenant)
		}
		p.IssuerURL = ""
	default:
		p.IssuerURL, p.Tenant = "", ""
	}
	return p, nil
}

// Providers faz o login pelos provedores configurados.
type Providers struct {
	client *http.Client

	mu        sync.Mutex
	discovery map[string]*oidc.Provider // por endereço do emissor
	pending   map[string]providerLogin
}

// providerLogin é um login iniciado e ainda não concluído.
type providerLogin struct {
	provider string
	verifier string
	nonce    string
	redirect string
	returnTo string
	expires  time.Time
}

// NewProviders prepara o cliente HTTP dos provedores.
func NewProviders() *Providers {
	return &Providers{
		client:    &http.Client{Timeout: providerHTTPLimit},
		discovery: map[string]*oidc.Provider{},
		pending:   map[string]providerLogin{},
	}
}

func (ps *Providers) ctx(ctx context.Context) context.Context {
	return oidc.ClientContext(ctx, ps.client)
}

// issuerFor é o emissor OIDC do provedor (vazio para o GitHub).
func issuerFor(p ProviderConfig) string {
	switch p.Type {
	case ProviderGoogle:
		return googleIssuer
	case ProviderMicrosoft:
		return fmt.Sprintf("%s/%s/v2.0", microsoftLogin, p.Tenant)
	case ProviderOIDC:
		return p.IssuerURL
	}
	return ""
}

func (ps *Providers) discover(ctx context.Context, p ProviderConfig) (*oidc.Provider, error) {
	issuer := issuerFor(p)
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if d, ok := ps.discovery[issuer]; ok {
		return d, nil
	}
	var d *oidc.Provider
	var err error
	if p.Type == ProviderMicrosoft {
		// Os inquilinos "common", "organizations" e "consumers" publicam um
		// emissor com {tenantid}: os endereços são montados aqui e o emissor de
		// cada token é conferido em microsoftEmail.
		base := fmt.Sprintf("%s/%s", microsoftLogin, p.Tenant)
		d = (&oidc.ProviderConfig{
			IssuerURL: issuer,
			AuthURL:   base + "/oauth2/v2.0/authorize",
			TokenURL:  base + "/oauth2/v2.0/token",
			JWKSURL:   base + "/discovery/v2.0/keys",
		}).NewProvider(ps.ctx(ctx))
	} else {
		d, err = oidc.NewProvider(ps.ctx(ctx), issuer)
	}
	if err != nil {
		return nil, fmt.Errorf("provedor %s inacessível: %w", p.Name, err)
	}
	ps.discovery[issuer] = d
	return d, nil
}

func (ps *Providers) oauth2Config(ctx context.Context, p ProviderConfig, redirect string) (*oauth2.Config, *oidc.Provider, error) {
	cfg := &oauth2.Config{ClientID: p.ClientID, ClientSecret: p.ClientSecret, RedirectURL: redirect}
	if p.Type == ProviderGitHub {
		cfg.Endpoint = oauth2.Endpoint{AuthURL: githubAuthURL, TokenURL: githubTokenURL, AuthStyle: oauth2.AuthStyleInParams}
		cfg.Scopes = []string{"read:user", "user:email"}
		return cfg, nil, nil
	}
	d, err := ps.discover(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	cfg.Endpoint = d.Endpoint()
	cfg.Scopes = []string{oidc.ScopeOpenID, "email", "profile"}
	return cfg, d, nil
}

// AuthURL inicia o login: devolve o endereço do provedor e o state, que o
// servidor guarda num cookie do navegador para conferir na volta.
func (ps *Providers) AuthURL(ctx context.Context, p ProviderConfig, redirect, returnTo string) (string, string, error) {
	cfg, _, err := ps.oauth2Config(ctx, p, redirect)
	if err != nil {
		return "", "", err
	}
	state, nonce, verifier := RandomToken(), RandomToken(), oauth2.GenerateVerifier()
	ps.mu.Lock()
	now := time.Now()
	for k, v := range ps.pending {
		if now.After(v.expires) {
			delete(ps.pending, k)
		}
	}
	ps.pending[state] = providerLogin{provider: p.ID, verifier: verifier, nonce: nonce, redirect: redirect, returnTo: returnTo, expires: now.Add(pendingTTL)}
	ps.mu.Unlock()

	opts := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(verifier)}
	if p.Type != ProviderGitHub {
		opts = append(opts, oidc.Nonce(nonce))
	}
	if p.Type == ProviderGoogle || p.Type == ProviderMicrosoft {
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "select_account"))
	}
	return cfg.AuthCodeURL(state, opts...), state, nil
}

// Identify conclui o login: confere o state (o mesmo do cookie), troca o
// código e devolve o e-mail verificado e o endereço para onde voltar.
func (ps *Providers) Identify(ctx context.Context, p ProviderConfig, state, cookieState, code string) (email, returnTo string, err error) {
	if state == "" || !Equal(state, cookieState) {
		return "", "", ErrOIDCState
	}
	ps.mu.Lock()
	pl, ok := ps.pending[state]
	delete(ps.pending, state) // uso único
	ps.mu.Unlock()
	if !ok || time.Now().After(pl.expires) || pl.provider != p.ID {
		return "", "", ErrOIDCState
	}
	cfg, d, err := ps.oauth2Config(ctx, p, pl.redirect)
	if err != nil {
		return "", "", err
	}
	tok, err := cfg.Exchange(ps.ctx(ctx), code, oauth2.VerifierOption(pl.verifier))
	if err != nil {
		return "", "", fmt.Errorf("trocando o código no provedor: %w", err)
	}
	if p.Type == ProviderGitHub {
		email, err = ps.githubEmail(ctx, tok)
		return email, pl.returnTo, err
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		return "", "", errors.New("o provedor não devolveu um ID token")
	}
	vcfg := &oidc.Config{ClientID: p.ClientID, SkipIssuerCheck: p.Type == ProviderMicrosoft}
	idt, err := d.VerifierContext(ps.ctx(ctx), vcfg).Verify(ps.ctx(ctx), raw)
	if err != nil {
		return "", "", fmt.Errorf("ID token inválido: %w", err)
	}
	if idt.Nonce == "" || !Equal(idt.Nonce, pl.nonce) {
		return "", "", errors.New("ID token com nonce inválido")
	}
	var claims map[string]any
	if err := idt.Claims(&claims); err != nil {
		return "", "", err
	}
	if p.Type == ProviderMicrosoft {
		email, err = microsoftEmail(p, idt.Issuer, claims)
	} else {
		email, err = verifiedEmail(claims)
	}
	return strings.ToLower(email), pl.returnTo, err
}

// verifiedEmail: e-mail com email_verified=true (Google e OIDC em geral).
func verifiedEmail(claims map[string]any) (string, error) {
	email, _ := claims["email"].(string)
	verified, _ := claims["email_verified"].(bool)
	if email == "" || !verified {
		return "", ErrUnverifiedEmail
	}
	return email, nil
}

// microsoftEmail confere o emissor do inquilino e escolhe um identificador
// confiável. Contas pessoais: o e-mail, verificado pela Microsoft. Contas de
// organizações: o nome de login (UPN), cujo domínio a organização precisou
// verificar; o campo "email" delas não é verificado e não é usado ("nOAuth").
func microsoftEmail(p ProviderConfig, issuer string, claims map[string]any) (string, error) {
	tid, _ := claims["tid"].(string)
	if tid == "" || issuer != fmt.Sprintf("%s/%s/v2.0", microsoftLogin, tid) {
		return "", fmt.Errorf("ID token com emissor inesperado: %s", issuer)
	}
	switch p.Tenant {
	case "common":
	case "consumers":
		if tid != microsoftConsumers {
			return "", fmt.Errorf("conta de organização num login só para contas pessoais (%s)", tid)
		}
	case "organizations":
		if tid == microsoftConsumers {
			return "", errors.New("conta pessoal num login só para organizações")
		}
	default:
		if tid != p.Tenant {
			return "", fmt.Errorf("conta de outra organização (%s)", tid)
		}
	}
	if tid == microsoftConsumers {
		if email, _ := claims["email"].(string); email != "" {
			return email, nil
		}
		return "", ErrUnverifiedEmail
	}
	upn, _ := claims["preferred_username"].(string)
	if upn == "" || strings.Contains(upn, "#EXT#") || !validEmail.MatchString(upn) {
		return "", ErrUnverifiedEmail
	}
	return upn, nil
}

// githubEmail busca o e-mail principal e verificado na API do GitHub.
func (ps *Providers) githubEmail(ctx context.Context, tok *oauth2.Token) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubAPI+"/user/emails", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	tok.SetAuthHeader(req)
	res, err := ps.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("consultando o GitHub: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("consultando o GitHub: HTTP %d", res.StatusCode)
	}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := json.NewDecoder(res.Body).Decode(&emails); err != nil {
		return "", err
	}
	for _, e := range emails {
		if e.Primary && e.Verified {
			return strings.ToLower(e.Email), nil
		}
	}
	return "", ErrUnverifiedEmail
}
