// Comando kubora: console web para gestão de clusters Kubernetes.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"kubora.dev/kubora/internal/cluster"
	"kubora.dev/kubora/internal/config"
	"kubora.dev/kubora/internal/server"
	"kubora.dev/kubora/internal/version"
	"kubora.dev/kubora/internal/web"
)

func main() {
	cfg := config.MustLoad()
	v := version.Get()
	if cfg.ShowVersion {
		fmt.Printf("kubora %s (commit %s, %s, %s)\n", v.Version, v.Commit, v.Date, v.GoVersion)
		return
	}
	log := newLogger(cfg)

	log.Info("iniciando Kubora", "versao", v.Version, "commit", v.Commit)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cl, err := cluster.New(cluster.Options{
		Mode:       cfg.Mode,
		Kubeconfig: cfg.Kubeconfig,
		Context:    cfg.Context,
		UserAgent:  "kubora/" + v.Version,
	})
	if err != nil {
		log.Error("não foi possível configurar o acesso ao cluster", "erro", err)
		os.Exit(1)
	}
	info := cl.Info(ctx)
	log.Info("cluster configurado", "modo", info.Mode, "contexto", info.Context, "servidor", info.Server,
		"versao", info.Version, "acessivel", info.Reachable)

	opts := server.Options{LoopbackOnly: cfg.ListenIsLoopback()}
	if !opts.LoopbackOnly && cl.Mode() == cluster.ModeLocal {
		// Até a autenticação existir (tarefa 0.3), qualquer pessoa que alcance
		// a porta age com as credenciais do kubeconfig.
		log.Warn("modo local exposto fora de localhost: qualquer pessoa na rede usará suas credenciais", "listen", cfg.Listen)
	}

	if err := server.New(log, web.Assets(), cl, opts).Run(ctx, cfg.Listen); err != nil {
		log.Error("servidor encerrado com erro", "erro", err)
		os.Exit(1)
	}
}

func newLogger(cfg config.Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, opts))
}
