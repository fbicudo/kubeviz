// Package server monta o servidor HTTP do KubeViz: API, health checks e UI.
package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"time"

	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/version"
	"github.com/fbicudo/kubeviz/backend/internal/web"
)

// Options ajusta o comportamento do servidor.
type Options struct {
	// LoopbackOnly deve ser true quando o servidor escuta só em localhost
	// (modo local). Ativa a verificação do cabeçalho Host contra DNS rebinding.
	LoopbackOnly bool
	// LocalToken é o token de inicialização do modo local, trocado por uma
	// sessão em /auth/local?token=... .
	LocalToken string
	// SessionTTL é a duração das sessões (padrão: 12 h).
	SessionTTL time.Duration
	// TLSCertFile e TLSKeyFile, quando definidos, ativam HTTPS. Os arquivos
	// são relidos quando mudam (renovação de certificado).
	TLSCertFile string
	TLSKeyFile  string
	// WhoAmI identifica o dono de uma credencial; nil = auth.WhoAmI.
	// Substituível nos testes.
	WhoAmI func(context.Context, *rest.Config) (auth.User, error)
}

// Server é o servidor HTTP do KubeViz.
type Server struct {
	log      *slog.Logger
	assets   fs.FS
	cluster  Cluster
	opts     Options
	sessions *auth.Store
	whoAmI   func(context.Context, *rest.Config) (auth.User, error)
}

// New cria um servidor que serve a UI a partir de assets e consulta o
// Kubernetes por meio de cl.
func New(log *slog.Logger, assets fs.FS, cl Cluster, opts Options) *Server {
	if opts.SessionTTL == 0 {
		opts.SessionTTL = 12 * time.Hour
	}
	s := &Server{log: log, assets: assets, cluster: cl, opts: opts, sessions: auth.NewStore(opts.SessionTTL), whoAmI: opts.WhoAmI}
	if s.whoAmI == nil {
		s.whoAmI = auth.WhoAmI
	}
	return s
}

// Handler devolve o roteador completo, já com os middlewares.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.ok)
	mux.HandleFunc("GET /readyz", s.ok)

	mux.HandleFunc("GET /api/v1/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, version.Get())
	})
	// Autenticação (públicas).
	mux.HandleFunc("GET /auth/local", s.localLogin)
	mux.HandleFunc("GET /api/v1/auth/session", s.getSession)
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.HandleFunc("POST /api/v1/auth/logout", s.logout)

	// Exigem sessão.
	mux.HandleFunc("GET /api/v1/cluster", s.requireAuth(s.getCluster))
	mux.HandleFunc("GET /api/v1/contexts", s.requireAuth(s.getContexts))
	mux.HandleFunc("PUT /api/v1/contexts/current", s.requireAuth(s.putCurrentContext))
	mux.HandleFunc(k8sPrefix+"/", s.requireAuth(s.k8sProxy))
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

	var h http.Handler = sameOriginWrites(mux)
	if s.opts.LoopbackOnly {
		h = loopbackHostOnly(h)
	}
	return recoverer(s.log, securityHeaders(requestLog(s.log, h)))
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

// Serve atende conexões de ln até ctx ser cancelado. Com TLSCertFile
// definido, serve HTTPS.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(s.log.Handler(), slog.LevelWarn),
	}

	scheme := "http"
	if s.opts.TLSCertFile != "" {
		cfg, err := s.tlsConfig()
		if err != nil {
			_ = ln.Close()
			return err
		}
		srv.TLSConfig = cfg
		ln = tls.NewListener(ln, cfg)
		scheme = "https"
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	s.log.Info("servidor iniciado", "endereco", scheme+"://"+ln.Addr().String())

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
