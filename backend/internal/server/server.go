// Package server monta o servidor HTTP do Kubora: API, health checks e UI.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"time"

	"kubora.dev/kubora/internal/version"
	"kubora.dev/kubora/internal/web"
)

// Server é o servidor HTTP do Kubora.
type Server struct {
	log    *slog.Logger
	assets fs.FS
}

// New cria um servidor que serve a UI a partir de assets.
func New(log *slog.Logger, assets fs.FS) *Server {
	return &Server{log: log, assets: assets}
}

// Handler devolve o roteador completo, já com os middlewares.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.ok)
	mux.HandleFunc("GET /readyz", s.ok)

	mux.HandleFunc("GET /api/v1/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, version.Get())
	})
	// Qualquer outra rota de API inexistente devolve 404 em JSON, nunca a UI.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "rota não encontrada")
	})

	// Sem método no padrão: "GET /" conflitaria com "/api/" no ServeMux.
	ui := web.Handler(s.assets)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		ui.ServeHTTP(w, r)
	})

	return recoverer(s.log, securityHeaders(requestLog(s.log, mux)))
}

func (s *Server) ok(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok"))
}

// Run escuta em addr até ctx ser cancelado e então encerra de forma graciosa.
func (s *Server) Run(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return s.Serve(ctx, ln)
}

// Serve atende conexões de ln até ctx ser cancelado.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(s.log.Handler(), slog.LevelWarn),
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	s.log.Info("servidor iniciado", "endereco", "http://"+ln.Addr().String())

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}

	s.log.Info("encerrando servidor")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// apiError é o formato padrão de erro da API.
type apiError struct {
	Error string `json:"error"`
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, apiError{Error: msg})
}
