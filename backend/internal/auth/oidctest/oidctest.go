// Package oidctest é um provedor OIDC falso para testes: descoberta, chaves,
// troca de código com PKCE e renovação por refresh token.
package oidctest

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

const ClientID = "kubeviz"
const ClientSecret = "segredo-de-teste"

// Provider é o provedor falso.
type Provider struct {
	URL string
	// CertPEM é o certificado do provedor com TLS (NewTLS).
	CertPEM []byte

	key    *rsa.PrivateKey
	signer jose.Signer

	mu sync.Mutex
	// Claims vão no ID token (além de iss, aud, exp, iat e nonce).
	Claims map[string]any
	// TTL é a validade do ID token.
	TTL time.Duration
	// IssueRefresh: devolver refresh token.
	IssueRefresh bool
	// RefreshFails: recusar renovações (acesso revogado).
	RefreshFails bool
	// Refreshes conta as renovações atendidas.
	Refreshes int

	codes map[string]grant
}

type grant struct {
	nonce, challenge, redirect string
}

// New sobe o provedor em HTTP; é encerrado ao fim do teste.
func New(t *testing.T) *Provider { return start(t, false) }

// NewTLS sobe o provedor em HTTPS (o API server só aceita emissores HTTPS).
func NewTLS(t *testing.T) *Provider { return start(t, true) }

func start(t *testing.T, useTLS bool) *Provider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "k1"))
	if err != nil {
		t.Fatal(err)
	}
	p := &Provider{
		key: key, signer: signer, TTL: time.Hour, IssueRefresh: true, codes: map[string]grant{},
		Claims: map[string]any{"sub": "u-123", "email": "ana@exemplo.com", "email_verified": true, "groups": []string{"dev"}},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", p.discovery)
	mux.HandleFunc("GET /keys", p.keys)
	mux.HandleFunc("POST /token", p.token)
	srv := httptest.NewUnstartedServer(mux)
	if useTLS {
		srv.StartTLS()
		p.CertPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	} else {
		srv.Start()
	}
	t.Cleanup(srv.Close)
	p.URL = srv.URL
	return p
}

func (p *Provider) discovery(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{
		"issuer":                                p.URL,
		"authorization_endpoint":                p.URL + "/auth",
		"token_endpoint":                        p.URL + "/token",
		"jwks_uri":                              p.URL + "/keys",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
	})
}

func (p *Provider) keys(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &p.key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
}

// Authorize faz o papel da pessoa entrando no provedor: recebe o endereço
// para onde o KubeViz mandou o navegador e devolve o endereço de retorno
// (callback com code e state).
func (p *Provider) Authorize(t *testing.T, authURL string) string {
	t.Helper()
	u, err := url.Parse(authURL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("client_id") != ClientID || q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("pedido de autorização inesperado: %s", authURL)
	}
	code := fmt.Sprintf("code-%d", time.Now().UnixNano())
	p.mu.Lock()
	p.codes[code] = grant{nonce: q.Get("nonce"), challenge: q.Get("code_challenge"), redirect: q.Get("redirect_uri")}
	p.mu.Unlock()
	back, _ := url.Parse(q.Get("redirect_uri"))
	bq := url.Values{"code": {code}, "state": {q.Get("state")}}
	back.RawQuery = bq.Encode()
	return back.String()
}

func (p *Provider) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	id, secret, _ := r.BasicAuth()
	if id == "" {
		id, secret = r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
	}
	if id != ClientID || secret != ClientSecret {
		oauthError(w, "invalid_client")
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	var nonce string
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		g, ok := p.codes[r.PostForm.Get("code")]
		delete(p.codes, r.PostForm.Get("code"))
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge || r.PostForm.Get("redirect_uri") != g.redirect {
			oauthError(w, "invalid_grant")
			return
		}
		nonce = g.nonce
	case "refresh_token":
		if p.RefreshFails || r.PostForm.Get("refresh_token") == "" {
			oauthError(w, "invalid_grant")
			return
		}
		p.Refreshes++
	default:
		oauthError(w, "unsupported_grant_type")
		return
	}

	now := time.Now()
	claims := maps.Clone(p.Claims)
	claims["iss"], claims["aud"] = p.URL, ClientID
	claims["iat"], claims["exp"], claims["jti"] = now.Unix(), now.Add(p.TTL).Unix(), fmt.Sprint(now.UnixNano())
	if nonce != "" {
		claims["nonce"] = nonce
	}
	payload, _ := json.Marshal(claims)
	sig, err := p.signer.Sign(payload)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	idToken, _ := sig.CompactSerialize()
	resp := map[string]any{"access_token": "at-" + nonce, "token_type": "Bearer", "expires_in": int(p.TTL.Seconds()), "id_token": idToken}
	if p.IssueRefresh {
		resp["refresh_token"] = fmt.Sprintf("rt-%d", now.UnixNano())
	}
	writeJSON(w, resp)
}

// Set altera o provedor com segurança enquanto ele atende pedidos.
func (p *Provider) Set(f func(p *Provider)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f(p)
}

// RefreshCount devolve quantas renovações foram atendidas.
func (p *Provider) RefreshCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.Refreshes
}

func oauthError(w http.ResponseWriter, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
