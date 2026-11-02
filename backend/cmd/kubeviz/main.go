// Comando kubeviz: console web para gestão de clusters Kubernetes.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
	"github.com/fbicudo/kubeviz/backend/internal/config"
	"github.com/fbicudo/kubeviz/backend/internal/metrics"
	"github.com/fbicudo/kubeviz/backend/internal/server"
	"github.com/fbicudo/kubeviz/backend/internal/store"
	"github.com/fbicudo/kubeviz/backend/internal/version"
	"github.com/fbicudo/kubeviz/backend/internal/web"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "user" {
		os.Exit(runUser(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	cfg := config.MustLoad()
	v := version.Get()
	if cfg.ShowVersion {
		fmt.Printf("kubeviz %s (commit %s, %s, %s)\n", v.Version, v.Commit, v.Date, v.GoVersion)
		return
	}
	log := newLogger(cfg)

	log.Info("iniciando KubeViz", "versao", v.Version, "commit", v.Commit)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cl, err := cluster.New(cluster.Options{
		Mode:       cfg.Mode,
		Kubeconfig: cfg.Kubeconfig,
		Context:    cfg.Context,
		UserAgent:  "kubeviz/" + v.Version,
	})
	if err != nil {
		log.Error("não foi possível configurar o acesso ao cluster", "erro", err)
		os.Exit(1)
	}
	info := cl.Info(ctx)
	log.Info("cluster configurado", "modo", info.Mode, "contexto", info.Context, "servidor", info.Server,
		"versao", info.Version, "acessivel", info.Reachable)

	opts := server.Options{
		LoopbackOnly: cfg.ListenIsLoopback(),
		TLSCertFile:  cfg.TLSCertFile,
		TLSKeyFile:   cfg.TLSKeyFile,
	}
	if o := cfg.OIDC; o.Enabled() {
		opts.OIDC, err = auth.NewOIDC(auth.OIDCConfig{
			IssuerURL: o.IssuerURL, ClientID: o.ClientID, ClientSecret: o.ClientSecret,
			RedirectURL: o.RedirectURL, Scopes: o.Scopes,
			UsernameClaim: o.UsernameClaim, GroupsClaim: o.GroupsClaim,
			UsernamePrefix: o.UsernamePrefix, GroupsPrefix: o.GroupsPrefix,
			Mode: auth.OIDCMode(o.Mode), CAFile: o.CAFile, DisplayName: o.DisplayName,
		})
		if err != nil {
			log.Error("configuração OIDC inválida", "erro", err)
			os.Exit(1)
		}
		log.Info("login OIDC habilitado", "provedor", o.IssuerURL, "modo", o.Mode, "retorno", o.RedirectURL)
	}
	if cl.Mode() == cluster.ModeLocal {
		opts.Users = auth.NewUsers(cfg.UsersFile)
		opts.Providers = auth.NewProviders()
		opts.LocalToken = auth.RandomToken()
		url := browserURL(cfg.Listen, cfg.TLSCertFile != "")
		if !opts.LoopbackOnly {
			// Exposto na rede: a conta de administrador precisa ser criada logo,
			// para ninguém tomar a instalação antes do dono.
			opts.SetupUntil = time.Now().Add(15 * time.Minute)
		}
		if opts.Users.Enabled() {
			fmt.Fprintf(os.Stderr, "\n  KubeViz pronto em %s\n  Entre com sua conta (contas em %s).\n\n", url, cfg.UsersFile)
		} else {
			fmt.Fprintf(os.Stderr, "\n  KubeViz pronto. Abra %s e crie a conta de administrador", url)
			if !opts.SetupUntil.IsZero() {
				fmt.Fprintf(os.Stderr, " até as %s", opts.SetupUntil.Format("15:04"))
			}
			// Como no Jupyter: o link do terminal também dá acesso direto.
			fmt.Fprintf(os.Stderr, ",\n  ou entre direto pelo link:\n\n    %s/auth/local?token=%s\n\n", url, opts.LocalToken)
		}
		if !opts.LoopbackOnly {
			log.Warn("modo local exposto fora de localhost: quem tiver o link usará suas credenciais do kubeconfig", "listen", cfg.Listen)
			if cfg.TLSCertFile == "" {
				log.Warn("sem HTTPS: o link e o cookie de sessão trafegam sem criptografia; use --tls-cert-file e --tls-key-file")
			}
		}
	}

	if cfg.MetricsCollector {
		if history, closeDB := startCollector(ctx, log, cfg, cl); history != nil {
			opts.History = history
			defer closeDB()
		}
	}

	if err := server.New(log, web.Assets(), cl, opts).Run(ctx, cfg.Listen); err != nil {
		log.Error("servidor encerrado com erro", "erro", err)
		os.Exit(1)
	}
}

// browserURL converte o endereço de escuta num endereço clicável.
func browserURL(listen string, https bool) string {
	scheme := "http://"
	if https {
		scheme = "https://"
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return scheme + listen
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return scheme + net.JoinHostPort(host, port)
}

func newLogger(cfg config.Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, opts))
}

// startCollector abre o banco e inicia o coletor embutido de métricas. Se o
// banco não puder ser aberto (disco somente leitura, por exemplo), o
// KubeViz segue sem histórico.
func startCollector(ctx context.Context, log *slog.Logger, cfg config.Config, cl *cluster.Manager) (*metrics.Collector, func()) {
	dir := cfg.DataDir
	if dir == "" {
		dir = defaultDataDir(cl.Mode())
	}
	db, err := store.Open(filepath.Join(dir, "kubeviz.db"))
	if err != nil {
		log.Warn("histórico de métricas desativado: não foi possível abrir o banco", "erro", err)
		return nil, nil
	}
	c := metrics.NewCollector(log, db, metrics.Options{
		Interval:  cfg.MetricsInterval,
		Retention: cfg.MetricsRetention,
		Target:    func() (*rest.Config, string) { return cl.RESTConfig(), cl.Name() },
	})
	go c.Run(ctx)
	log.Info("coletor de métricas iniciado", "banco", db.Path(), "intervalo", cfg.MetricsInterval, "retencao", cfg.MetricsRetention)
	return c, func() { db.Close() }
}

func defaultDataDir(mode cluster.Mode) string {
	if mode == cluster.ModeInCluster {
		return "/var/lib/kubeviz"
	}
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "kubeviz", "data")
	}
	return "kubeviz-data"
}
