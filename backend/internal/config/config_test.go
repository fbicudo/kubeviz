package config

import (
	"log/slog"
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
		"KUBORA_LISTEN":    "0.0.0.0:4466",
		"KUBORA_LOG_LEVEL": "debug",
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
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(args, env(nil)); err == nil {
				t.Error("esperava erro")
			}
		})
	}
}
