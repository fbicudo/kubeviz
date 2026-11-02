package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

const sessionCookie = "kubeviz_session"

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
// quem executou o KubeViz.
func (s *Server) localLogin(w http.ResponseWriter, r *http.Request) {
	// Com contas locais criadas, o link com token deixa de valer: quem chega
	// por um link antigo vai para a tela de login (sem ganhar acesso algum).
	if s.passwordEnabled() {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	if s.cluster.Mode() != cluster.ModeLocal || s.opts.LocalToken == "" {
		http.NotFound(w, r)
		return
	}
	if !auth.Equal(r.URL.Query().Get("token"), s.opts.LocalToken) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("Token inválido. Use o link exibido no terminal em que o KubeViz foi iniciado.\n"))
		return
	}
	sess := s.sessions.Create(auth.User{}, "")
	s.setSessionCookie(w, r, sess)
	s.log.Info("sessão local iniciada")
	// Redireciona para tirar o token da barra de endereços e do histórico.
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) passwordEnabled() bool {
	return s.cluster.Mode() == cluster.ModeLocal && s.opts.Users != nil && s.opts.Users.Enabled()
}

// loginMethods informa à tela de login como entrar.
func (s *Server) loginMethods() []string {
	switch {
	case s.cluster.Mode() == cluster.ModeInCluster:
		return []string{"token"}
	case s.passwordEnabled():
		return []string{"password"}
	default:
		return []string{"link"}
	}
}

// passwordLogin autentica uma conta local (modo local). Erros não revelam se
// o usuário existe; tentativas erradas são limitadas por IP e por usuário.
func (s *Server) passwordLogin(w http.ResponseWriter, r *http.Request) {
	if !s.passwordEnabled() {
		writeError(w, http.StatusNotFound, "login por usuário e senha não está habilitado")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.Password == "" {
		writeError(w, http.StatusBadRequest, `corpo inválido: esperado {"username": "...", "password": "..."}`)
		return
	}
	name := strings.ToLower(strings.TrimSpace(body.Username))
	keys := []string{"ip:" + clientIP(r), "user:" + name}

	if blocked, wait := s.limiter.Blocked(keys...); blocked {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "muitas tentativas; tente novamente mais tarde")
		return
	}
	if !s.opts.Users.Verify(name, body.Password) {
		s.limiter.Fail(keys...)
		s.log.Warn("login por senha recusado", "usuario", name, "origem", clientIP(r))
		writeError(w, http.StatusUnauthorized, "usuário ou senha inválidos")
		return
	}
	s.limiter.Reset(keys...)

	sess := s.sessions.Create(auth.User{}, "")
	sess.LocalUser = name
	s.setSessionCookie(w, r, sess)
	s.log.Info("login por senha", "usuario", name)
	writeJSON(w, http.StatusOK, s.sessionInfo(r, sess))
}

// clientIP é o endereço de quem fez a requisição (sem confiar em cabeçalhos
// de proxy, que o cliente poderia forjar para fugir do limite de tentativas).
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
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
	writeJSON(w, http.StatusOK, s.sessionInfo(r, sess))
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
	// LoginMethods: "link" (token no terminal), "password" ou "token".
	LoginMethods []string   `json:"loginMethods"`
	User         *auth.User `json:"user,omitempty"`
	// LocalUser é a conta local da sessão (login por usuário e senha).
	LocalUser string     `json:"localUser,omitempty"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	// UserError explica por que a identidade não pôde ser obtida (modo local
	// com cluster inacessível, por exemplo).
	UserError string `json:"userError,omitempty"`
}

// getSession é público: a UI o usa para decidir entre a tela de login e a
// aplicação.
func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.session(r)
	if !ok {
		writeJSON(w, http.StatusOK, sessionResponse{Mode: s.cluster.Mode(), LoginMethods: s.loginMethods()})
		return
	}
	writeJSON(w, http.StatusOK, s.sessionInfo(r, sess))
}

func (s *Server) sessionInfo(r *http.Request, sess *auth.Session) sessionResponse {
	resp := sessionResponse{
		Mode:          s.cluster.Mode(),
		Authenticated: true,
		LoginMethods:  s.loginMethods(),
		LocalUser:     sess.LocalUser,
		ExpiresAt:     &sess.Expires,
	}

	if s.cluster.Mode() == cluster.ModeInCluster {
		resp.User = &sess.User
	} else if user, err := s.whoAmI(r.Context(), s.userConfig(sess)); err == nil {
		// No modo local a identidade muda com o contexto; é consultada na hora.
		resp.User = &user
	} else {
		resp.UserError = err.Error()
	}
	return resp
}
