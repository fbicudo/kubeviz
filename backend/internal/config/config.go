// Package config lê a configuração do Kubora a partir de flags e variáveis de
// ambiente. Flags têm precedência sobre variáveis de ambiente.
package config

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strings"
)

const envPrefix = "KUBORA_"

// Config reúne as opções de execução.
type Config struct {
	// Listen é o endereço HTTP. O padrão escuta apenas em localhost (modo
	// local); no cluster o Helm chart define 0.0.0.0:4466.
	Listen string
	// Kubeconfig é o caminho do kubeconfig no modo local. Vazio = padrão do
	// kubectl ($KUBECONFIG ou ~/.kube/config) ou configuração in-cluster.
	Kubeconfig string
	// Context é o contexto inicial do kubeconfig; vazio = current-context.
	Context string
	// Mode: auto, local ou in-cluster.
	Mode string
	// LogLevel: debug, info, warn ou error.
	LogLevel slog.Level
	// LogFormat: text ou json.
	LogFormat string
	// ShowVersion: imprime a versão e sai.
	ShowVersion bool
}

// Load interpreta args (sem o nome do programa) usando getenv para ler o
// ambiente. Recebe getenv como parâmetro para facilitar os testes.
func Load(args []string, getenv func(string) string) (Config, error) {
	fs := flag.NewFlagSet("kubora", flag.ContinueOnError)

	env := func(name, def string) string {
		if v := getenv(envPrefix + name); v != "" {
			return v
		}
		return def
	}

	var c Config
	var level string
	fs.StringVar(&c.Listen, "listen", env("LISTEN", "127.0.0.1:4466"), "endereço HTTP (env KUBORA_LISTEN)")
	fs.StringVar(&c.Kubeconfig, "kubeconfig", env("KUBECONFIG", ""), "caminho do kubeconfig (env KUBORA_KUBECONFIG)")
	fs.StringVar(&c.Context, "context", env("CONTEXT", ""), "contexto inicial do kubeconfig (env KUBORA_CONTEXT)")
	fs.StringVar(&c.Mode, "mode", env("MODE", "auto"), "auto|local|in-cluster (env KUBORA_MODE)")
	fs.StringVar(&level, "log-level", env("LOG_LEVEL", "info"), "debug|info|warn|error (env KUBORA_LOG_LEVEL)")
	fs.StringVar(&c.LogFormat, "log-format", env("LOG_FORMAT", "text"), "text|json (env KUBORA_LOG_FORMAT)")
	fs.BoolVar(&c.ShowVersion, "version", false, "imprime a versão e sai")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if fs.NArg() > 0 {
		return Config{}, fmt.Errorf("argumentos inesperados: %s", strings.Join(fs.Args(), " "))
	}
	if err := c.LogLevel.UnmarshalText([]byte(level)); err != nil {
		return Config{}, fmt.Errorf("log-level inválido %q", level)
	}
	if c.LogFormat != "text" && c.LogFormat != "json" {
		return Config{}, fmt.Errorf("log-format inválido %q (use text ou json)", c.LogFormat)
	}
	switch c.Mode {
	case "auto", "local", "in-cluster":
	default:
		return Config{}, fmt.Errorf("mode inválido %q (use auto, local ou in-cluster)", c.Mode)
	}
	if _, _, err := net.SplitHostPort(c.Listen); err != nil {
		return Config{}, fmt.Errorf("listen inválido %q: %w", c.Listen, err)
	}
	return c, nil
}

// ListenIsLoopback indica se o servidor escuta apenas em localhost. Nesse
// caso, o Kubora age com as credenciais do kubeconfig de quem o executa e
// precisa recusar requisições vindas de outros sites (ver server.Options).
func (c Config) ListenIsLoopback() bool {
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// MustLoad é Load com os argumentos e o ambiente do processo. Sai com código 2
// em caso de erro (0 para -h/--help).
func MustLoad() Config {
	c, err := Load(os.Args[1:], os.Getenv)
	if errors.Is(err, flag.ErrHelp) {
		os.Exit(0)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro de configuração:", err)
		os.Exit(2)
	}
	return c
}
