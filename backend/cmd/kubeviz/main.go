// Comando kubeviz: console web para gestão de clusters Kubernetes.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
	"github.com/fbicudo/kubeviz/backend/internal/config"
	"github.com/fbicudo/kubeviz/backend/internal/server"
	"github.com/fbicudo/kubeviz/backend/internal/version"
	"github.com/fbicudo/kubeviz/backend/internal/web"
)

func main() {
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
	if cl.Mode() == cluster.ModeLocal {
		opts.LocalToken = auth.RandomToken()
		// Como no Jupyter: só quem vê o terminal recebe o link de acesso.
		fmt.Fprintf(os.Stderr, "\n  KubeViz pronto. Abra no navegador:\n\n    %s/auth/local?token=%s\n\n", browserURL(cfg.Listen, cfg.TLSCertFile != ""), opts.LocalToken)
		if !opts.LoopbackOnly {
			log.Warn("modo local exposto fora de localhost: quem tiver o link usará suas credenciais do kubeconfig", "listen", cfg.Listen)
			if cfg.TLSCertFile == "" {
				log.Warn("sem HTTPS: o link e o cookie de sessão trafegam sem criptografia; use --tls-cert-file e --tls-key-file")
			}
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
