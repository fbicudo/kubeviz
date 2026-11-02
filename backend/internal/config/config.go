// Package config lê a configuração do KubeViz a partir de flags e variáveis de
// ambiente. Flags têm precedência sobre variáveis de ambiente.
package config

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const envPrefix = "KUBEVIZ_"

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
	// UsersFile é o arquivo de contas locais (usuário e senha) do modo local.
	UsersFile string
	// TLSCertFile e TLSKeyFile ativam HTTPS (os dois ou nenhum).
	TLSCertFile string
	TLSKeyFile  string
	// ShowVersion: imprime a versão e sai.
	ShowVersion bool
	// OIDC é o login corporativo; desativado se IssuerURL estiver vazio.
	OIDC OIDC
	// DataDir guarda o banco (histórico de métricas). Vazio = padrão do modo.
	DataDir string
	// MetricsCollector liga o coletor embutido de métricas.
	MetricsCollector bool
	// MetricsInterval é o intervalo entre amostras.
	MetricsInterval time.Duration
	// MetricsRetention é por quanto tempo o histórico é guardado.
	MetricsRetention time.Duration
}

// OIDC são as opções do login corporativo (ver auth.OIDCConfig).
type OIDC struct {
	IssuerURL        string
	ClientID         string
	ClientSecret     string
	ClientSecretFile string
	RedirectURL      string
	Scopes           []string
	UsernameClaim    string
	GroupsClaim      string
	UsernamePrefix   string
	GroupsPrefix     string
	Mode             string
	CAFile           string
	DisplayName      string
}

// Enabled indica se o login OIDC foi configurado.
func (o OIDC) Enabled() bool { return o.IssuerURL != "" }

// Load interpreta args (sem o nome do programa) usando getenv para ler o
// ambiente. Recebe getenv como parâmetro para facilitar os testes.
func Load(args []string, getenv func(string) string) (Config, error) {
	fs := flag.NewFlagSet("kubeviz", flag.ContinueOnError)

	env := func(name, def string) string {
		if v := getenv(envPrefix + name); v != "" {
			return v
		}
		return def
	}

	var c Config
	var level string
	fs.StringVar(&c.Listen, "listen", env("LISTEN", "127.0.0.1:4466"), "endereço HTTP (env KUBEVIZ_LISTEN)")
	fs.StringVar(&c.Kubeconfig, "kubeconfig", env("KUBECONFIG", ""), "caminho do kubeconfig (env KUBEVIZ_KUBECONFIG)")
	fs.StringVar(&c.Context, "context", env("CONTEXT", ""), "contexto inicial do kubeconfig (env KUBEVIZ_CONTEXT)")
	fs.StringVar(&c.Mode, "mode", env("MODE", "auto"), "auto|local|in-cluster (env KUBEVIZ_MODE)")
	fs.StringVar(&level, "log-level", env("LOG_LEVEL", "info"), "debug|info|warn|error (env KUBEVIZ_LOG_LEVEL)")
	fs.StringVar(&c.LogFormat, "log-format", env("LOG_FORMAT", "text"), "text|json (env KUBEVIZ_LOG_FORMAT)")
	fs.StringVar(&c.UsersFile, "users-file", env("USERS_FILE", DefaultUsersFile()), "contas de login do modo local; gerencie com 'kubeviz user' (env KUBEVIZ_USERS_FILE)")
	fs.StringVar(&c.TLSCertFile, "tls-cert-file", env("TLS_CERT_FILE", ""), "certificado TLS em PEM; ativa HTTPS (env KUBEVIZ_TLS_CERT_FILE)")
	fs.StringVar(&c.TLSKeyFile, "tls-key-file", env("TLS_KEY_FILE", ""), "chave privada TLS em PEM (env KUBEVIZ_TLS_KEY_FILE)")
	fs.BoolVar(&c.ShowVersion, "version", false, "imprime a versão e sai")

	fs.StringVar(&c.DataDir, "data-dir", env("DATA_DIR", ""), "diretório do banco (histórico); padrão: ~/.config/kubeviz/data ou /var/lib/kubeviz no cluster (env KUBEVIZ_DATA_DIR)")
	fs.BoolVar(&c.MetricsCollector, "metrics-collector", env("METRICS_COLLECTOR", "true") != "false", "coletor embutido de métricas (env KUBEVIZ_METRICS_COLLECTOR=false desliga)")
	interval, _ := time.ParseDuration(env("METRICS_INTERVAL", "30s"))
	fs.DurationVar(&c.MetricsInterval, "metrics-interval", interval, "intervalo entre amostras do coletor (env KUBEVIZ_METRICS_INTERVAL)")
	retention, _ := time.ParseDuration(env("METRICS_RETENTION", "720h"))
	fs.DurationVar(&c.MetricsRetention, "metrics-retention", retention, "por quanto tempo guardar o histórico, mínimo 168h (env KUBEVIZ_METRICS_RETENTION)")

	o := &c.OIDC
	var scopes string
	fs.StringVar(&o.IssuerURL, "oidc-issuer-url", env("OIDC_ISSUER_URL", ""), "provedor OIDC; ativa o login corporativo (env KUBEVIZ_OIDC_ISSUER_URL)")
	fs.StringVar(&o.ClientID, "oidc-client-id", env("OIDC_CLIENT_ID", ""), "client ID no provedor OIDC (env KUBEVIZ_OIDC_CLIENT_ID)")
	// O segredo só por variável de ambiente ou arquivo: flags aparecem na lista de processos.
	o.ClientSecret = getenv(envPrefix + "OIDC_CLIENT_SECRET")
	fs.StringVar(&o.ClientSecretFile, "oidc-client-secret-file", env("OIDC_CLIENT_SECRET_FILE", ""), "arquivo com o client secret; ou use a env KUBEVIZ_OIDC_CLIENT_SECRET")
	fs.StringVar(&o.RedirectURL, "oidc-redirect-url", env("OIDC_REDIRECT_URL", ""), "endereço público de /auth/oidc/callback, ex.: https://kubeviz.exemplo.com/auth/oidc/callback (env KUBEVIZ_OIDC_REDIRECT_URL)")
	fs.StringVar(&scopes, "oidc-scopes", env("OIDC_SCOPES", "openid,profile,email"), "escopos pedidos, separados por vírgula; acrescente groups e offline_access no Dex (env KUBEVIZ_OIDC_SCOPES)")
	fs.StringVar(&o.UsernameClaim, "oidc-username-claim", env("OIDC_USERNAME_CLAIM", "email"), "campo do ID token com o nome do usuário (env KUBEVIZ_OIDC_USERNAME_CLAIM)")
	fs.StringVar(&o.GroupsClaim, "oidc-groups-claim", env("OIDC_GROUPS_CLAIM", "groups"), "campo do ID token com os grupos (env KUBEVIZ_OIDC_GROUPS_CLAIM)")
	fs.StringVar(&o.UsernamePrefix, "oidc-username-prefix", env("OIDC_USERNAME_PREFIX", "oidc:"), "prefixo do usuário no cluster (modo impersonate); \"-\" = nenhum (env KUBEVIZ_OIDC_USERNAME_PREFIX)")
	fs.StringVar(&o.GroupsPrefix, "oidc-groups-prefix", env("OIDC_GROUPS_PREFIX", "oidc:"), "prefixo dos grupos no cluster (modo impersonate); \"-\" = nenhum (env KUBEVIZ_OIDC_GROUPS_PREFIX)")
	fs.StringVar(&o.Mode, "oidc-mode", env("OIDC_MODE", "impersonate"), "impersonate|token: como a identidade chega ao cluster (env KUBEVIZ_OIDC_MODE)")
	fs.StringVar(&o.CAFile, "oidc-ca-file", env("OIDC_CA_FILE", ""), "CA do provedor OIDC em PEM, se não for pública (env KUBEVIZ_OIDC_CA_FILE)")
	fs.StringVar(&o.DisplayName, "oidc-display-name", env("OIDC_DISPLAY_NAME", ""), "nome do provedor no botão de login, ex.: Keycloak (env KUBEVIZ_OIDC_DISPLAY_NAME)")

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
	if (c.TLSCertFile == "") != (c.TLSKeyFile == "") {
		return Config{}, errors.New("informe --tls-cert-file e --tls-key-file juntos")
	}
	switch c.Mode {
	case "auto", "local", "in-cluster":
	default:
		return Config{}, fmt.Errorf("mode inválido %q (use auto, local ou in-cluster)", c.Mode)
	}
	if _, _, err := net.SplitHostPort(c.Listen); err != nil {
		return Config{}, fmt.Errorf("listen inválido %q: %w", c.Listen, err)
	}
	if c.MetricsInterval < 10*time.Second {
		return Config{}, fmt.Errorf("metrics-interval mínimo é 10s (recebido %s)", c.MetricsInterval)
	}
	if c.MetricsRetention < 7*24*time.Hour {
		return Config{}, fmt.Errorf("metrics-retention mínimo é 168h (7 dias); recebido %s", c.MetricsRetention)
	}
	for _, s := range strings.Split(scopes, ",") {
		if s = strings.TrimSpace(s); s != "" {
			o.Scopes = append(o.Scopes, s)
		}
	}
	if err := o.validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

func (o *OIDC) validate() error {
	if !o.Enabled() {
		return nil
	}
	if err := checkURL("oidc-issuer-url", o.IssuerURL); err != nil {
		return err
	}
	if err := checkURL("oidc-redirect-url", o.RedirectURL); err != nil {
		return err
	}
	if o.ClientID == "" {
		return errors.New("informe --oidc-client-id")
	}
	if o.ClientSecretFile != "" {
		b, err := os.ReadFile(o.ClientSecretFile)
		if err != nil {
			return fmt.Errorf("lendo oidc-client-secret-file: %w", err)
		}
		o.ClientSecret = strings.TrimSpace(string(b))
	}
	if o.Mode != "impersonate" && o.Mode != "token" {
		return fmt.Errorf("oidc-mode inválido %q (use impersonate ou token)", o.Mode)
	}
	if !slices.Contains(o.Scopes, "openid") {
		return errors.New("oidc-scopes precisa incluir openid")
	}
	if o.UsernamePrefix == "-" {
		o.UsernamePrefix = ""
	}
	if o.GroupsPrefix == "-" {
		o.GroupsPrefix = ""
	}
	return nil
}

// checkURL exige HTTPS, exceto em localhost (ambiente de desenvolvimento).
func checkURL(name, raw string) error {
	if raw == "" {
		return fmt.Errorf("informe --%s", name)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("%s inválido %q", name, raw)
	}
	if u.Scheme == "https" {
		return nil
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); u.Scheme == "http" && (host == "localhost" || (ip != nil && ip.IsLoopback())) {
		return nil
	}
	return fmt.Errorf("%s precisa usar https (http só em localhost): %q", name, raw)
}

// DefaultUsersFile é ~/.config/kubeviz/users (ou o equivalente do sistema).
func DefaultUsersFile() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "kubeviz-users"
	}
	return filepath.Join(dir, "kubeviz", "users")
}

// ListenIsLoopback indica se o servidor escuta apenas em localhost. Nesse
// caso, o KubeViz age com as credenciais do kubeconfig de quem o executa e
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
