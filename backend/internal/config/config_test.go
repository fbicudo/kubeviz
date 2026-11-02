package config

import (
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(nil, env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != "127.0.0.1:4466" {
		t.Errorf("Listen = %q", c.Listen)
	}
	if c.LogLevel != slog.LevelInfo || c.LogFormat != "text" {
		t.Errorf("log = %v/%q", c.LogLevel, c.LogFormat)
	}
}

func TestFlagOverridesEnv(t *testing.T) {
	c, err := Load([]string{"--listen", ":9000"}, env(map[string]string{
		"KUBEVIZ_LISTEN":    "0.0.0.0:4466",
		"KUBEVIZ_LOG_LEVEL": "debug",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != ":9000" {
		t.Errorf("Listen = %q, flag deveria vencer o ambiente", c.Listen)
	}
	if c.LogLevel != slog.LevelDebug {
		t.Errorf("LogLevel = %v, deveria vir do ambiente", c.LogLevel)
	}
}

func TestListenIsLoopback(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:4466": true,
		"localhost:4466": true,
		"[::1]:4466":     true,
		"0.0.0.0:4466":   false,
		":4466":          false,
		"10.0.0.5:4466":  false,
	}
	for listen, want := range cases {
		if got := (Config{Listen: listen}).ListenIsLoopback(); got != want {
			t.Errorf("%s: %v, quer %v", listen, got, want)
		}
	}
}

func TestLoadInvalid(t *testing.T) {
	cases := map[string][]string{
		"listen sem porta": {"--listen", "localhost"},
		"nível inválido":   {"--log-level", "verbose"},
		"formato inválido": {"--log-format", "xml"},
		"argumento solto":  {"extra"},
		"modo inválido":    {"--mode", "remoto"},
		"TLS sem chave":    {"--tls-cert-file", "c.pem"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(args, env(nil)); err == nil {
				t.Error("esperava erro")
			}
		})
	}
}

func TestOIDC(t *testing.T) {
	base := []string{"--oidc-issuer-url", "https://idp.exemplo.com", "--oidc-client-id", "kubeviz",
		"--oidc-redirect-url", "https://kubeviz.exemplo.com/auth/oidc/callback"}

	c, err := Load(base, env(map[string]string{"KUBEVIZ_OIDC_CLIENT_SECRET": "s3"}))
	if err != nil {
		t.Fatal(err)
	}
	o := c.OIDC
	if !o.Enabled() || o.ClientSecret != "s3" || o.Mode != "impersonate" || o.UsernamePrefix != "oidc:" ||
		o.UsernameClaim != "email" || strings.Join(o.Scopes, " ") != "openid profile email" {
		t.Errorf("padrões: %+v", o)
	}

	secret := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secret, []byte("do-arquivo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err = Load(append(base, "--oidc-client-secret-file", secret, "--oidc-username-prefix", "-",
		"--oidc-scopes", "openid, groups,offline_access", "--oidc-mode", "token"), env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.OIDC.ClientSecret != "do-arquivo" || c.OIDC.UsernamePrefix != "" || len(c.OIDC.Scopes) != 3 || c.OIDC.Mode != "token" {
		t.Errorf("opções: %+v", c.OIDC)
	}

	// http só em localhost (desenvolvimento).
	if _, err := Load([]string{"--oidc-issuer-url", "http://127.0.0.1:5556/dex", "--oidc-client-id", "k",
		"--oidc-redirect-url", "http://localhost:4466/auth/oidc/callback"}, env(nil)); err != nil {
		t.Errorf("localhost: %v", err)
	}

	for name, extra := range map[string][]string{
		"issuer sem https":    {"--oidc-issuer-url", "http://idp.exemplo.com"},
		"sem client id":       {"--oidc-client-id", ""},
		"sem redirect":        {"--oidc-redirect-url", ""},
		"modo inválido":       {"--oidc-mode", "outro"},
		"sem escopo openid":   {"--oidc-scopes", "email"},
		"arquivo inexistente": {"--oidc-client-secret-file", "/nao/existe"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(append(slices.Clone(base), extra...), env(nil)); err == nil {
				t.Error("esperava erro")
			}
		})
	}
}
