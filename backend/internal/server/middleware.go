package server

import (
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// contentSecurityPolicy restringe a UI à própria origem. 'unsafe-inline' em
// style-src é necessário porque os componentes Radix usam atributos style.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; " +
	"font-src 'self'; " +
	"connect-src 'self'; " +
	"worker-src 'self' blob:; " +
	"frame-ancestors 'none'; " +
	"base-uri 'self'; " +
	"form-action 'self'"

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		if r.TLS != nil {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// loopbackHostOnly recusa requisições cujo cabeçalho Host não seja localhost.
// Protege contra DNS rebinding: um site malicioso que aponte seu domínio para
// 127.0.0.1 não consegue usar as credenciais do kubeconfig do usuário.
func loopbackHostOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(r.Host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			writeError(w, http.StatusForbidden, "host não permitido; acesse por localhost ou 127.0.0.1")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// writeContentTypes são os tipos aceitos em requisições que alteram estado:
// JSON e os formatos de patch do Kubernetes. Nenhum deles é um tipo "simples"
// do CORS, então um site de outra origem não consegue enviá-los sem preflight.
var writeContentTypes = map[string]bool{
	"application/json":                       true,
	"application/apply-patch+yaml":           true,
	"application/merge-patch+json":           true,
	"application/strategic-merge-patch+json": true,
	"application/json-patch+json":            true,
}

// sameOriginWrites recusa requisições que alteram estado vindas de outro site
// (CSRF). Exige JSON, o que força preflight CORS em requisições de outras
// origens, e confere Sec-Fetch-Site e Origin quando presentes.
func sameOriginWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
			writeError(w, http.StatusForbidden, "requisição de outra origem recusada")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host {
				writeError(w, http.StatusForbidden, "requisição de outra origem recusada")
				return
			}
		}
		if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); !writeContentTypes[ct] {
			writeError(w, http.StatusUnsupportedMediaType, "Content-Type deve ser application/json ou um tipo de patch do Kubernetes")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// sameOriginWebSockets recusa WebSockets abertos por páginas de outra origem
// (Cross-Site WebSocket Hijacking). O cookie SameSite=Strict já impede outros
// sites; esta verificação cobre também origens do mesmo site (subdomínios).
func sameOriginWebSockets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host {
					writeError(w, http.StatusForbidden, "WebSocket de outra origem recusado")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Unwrap permite que http.ResponseController alcance o writer original
// (necessário para flush e WebSockets nas próximas fases).
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func requestLog(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			return
		}
		log.Debug("requisição",
			"metodo", r.Method,
			"caminho", r.URL.Path,
			"status", rec.status,
			"duracao", time.Since(start).Round(time.Microsecond),
		)
	})
}

func recoverer(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				log.Error("panic ao atender requisição", "caminho", r.URL.Path, "erro", v)
				writeError(w, http.StatusInternalServerError, "erro interno")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
