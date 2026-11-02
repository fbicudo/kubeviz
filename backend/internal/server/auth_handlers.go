package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"k8s.io/client-go/rest"

	"kubora.dev/kubora/internal/auth"
	"kubora.dev/kubora/internal/cluster"
)

const sessionCookie = "kubora_session"

type sessionKey struct{}

func sessionFrom(ctx context.Context) *auth.Session {
	sess, _ := ctx.Value(sessionKey{}).(*auth.Session)
	return sess
}

// session devolve a sessão do cookie, se válida.
func (s *Server) session(r *http.Request) (*auth.Session, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil, false
	}
	return s.sessions.Get(c.Value)
}

// requireAuth recusa com 401 requisições sem sessão válida.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := s.session(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "sessão ausente ou expirada")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), sessionKey{}, sess)))
	}
}

// userConfig devolve as credenciais com que a sessão fala com a API: o
// kubeconfig no modo local; o token da própria pessoa no modo in-cluster.
func (s *Server) userConfig(sess *auth.Session) *rest.Config {
	if s.cluster.Mode() == cluster.ModeLocal {
		return s.cluster.RESTConfig()
	}
	return s.cluster.ConfigForToken(sess.Token)
}

func (s *Server) setSessionCookie(w http.ResponseWriter, r *http.Request, sess *auth.Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sess.ID,
		Path:     "/",
		MaxAge:   int(s.sessions.TTL() / time.Second),
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteStrictMode,
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteStrictMode,
	})
}

// isHTTPS considera o TLS terminado num Ingress (X-Forwarded-Proto). O
// cabeçalho só influencia o atributo Secure do cookie.
func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// localLogin troca o token de inicialização (exibido no terminal) por uma
// sessão. Impede que outros usuários da mesma máquina usem o kubeconfig de
// quem executou o Kubora.
func (s *Server) localLogin(w http.ResponseWriter, r *http.Request) {
	if s.cluster.Mode() != cluster.ModeLocal || s.opts.LocalToken == "" {
		http.NotFound(w, r)
		return
	}
	if !auth.Equal(r.URL.Query().Get("token"), s.opts.LocalToken) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("Token inválido. Use o link exibido no terminal em que o Kubora foi iniciado.\n"))
		return
	}
	sess := s.sessions.Create(auth.User{}, "")
	s.setSessionCookie(w, r, sess)
	s.log.Info("sessão local iniciada")
	// Redireciona para tirar o token da barra de endereços e do histórico.
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if s.cluster.Mode() != cluster.ModeInCluster {
		writeError(w, http.StatusConflict, "no modo local, use o link exibido no terminal")
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Token == "" {
		writeError(w, http.StatusBadRequest, `corpo inválido: esperado {"token": "..."}`)
		return
	}

	user, err := s.whoAmI(r.Context(), s.cluster.ConfigForToken(body.Token))
	if errors.Is(err, auth.ErrInvalidCredentials) {
		s.log.Warn("login recusado", "motivo", "token inválido", "origem", r.RemoteAddr)
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	sess := s.sessions.Create(user, body.Token)
	s.setSessionCookie(w, r, sess)
	s.log.Info("login", "usuario", user.Username)
	writeJSON(w, http.StatusOK, sessionResponse{Mode: s.cluster.Mode(), Authenticated: true, User: &user, ExpiresAt: &sess.Expires})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if sess, ok := s.session(r); ok {
		s.sessions.Delete(sess.ID)
	}
	clearSessionCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

type sessionResponse struct {
	Mode          cluster.Mode `json:"mode"`
	Authenticated bool         `json:"authenticated"`
	User          *auth.User   `json:"user,omitempty"`
	ExpiresAt     *time.Time   `json:"expiresAt,omitempty"`
	// UserError explica por que a identidade não pôde ser obtida (modo local
	// com cluster inacessível, por exemplo).
	UserError string `json:"userError,omitempty"`
}

// getSession é público: a UI o usa para decidir entre a tela de login e a
// aplicação.
func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	resp := sessionResponse{Mode: s.cluster.Mode()}
	sess, ok := s.session(r)
	if !ok {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.Authenticated = true
	resp.ExpiresAt = &sess.Expires

	if s.cluster.Mode() == cluster.ModeInCluster {
		resp.User = &sess.User
	} else if user, err := s.whoAmI(r.Context(), s.userConfig(sess)); err == nil {
		// No modo local a identidade muda com o contexto; é consultada na hora.
		resp.User = &user
	} else {
		resp.UserError = err.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}
