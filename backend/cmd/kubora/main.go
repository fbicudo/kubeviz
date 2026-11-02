// Comando kubora: console web para gestão de clusters Kubernetes.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

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

	if err := server.New(log, web.Assets()).Run(ctx, cfg.Listen); err != nil {
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
