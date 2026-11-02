package server

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
)

// oidcStateCookie liga o retorno do provedor ao navegador que iniciou o
// login. SameSite=Lax: a volta do provedor é uma navegação de outro site.
const oidcStateCookie = "kubeviz_oidc_state"

// oidcLogin manda o navegador ao provedor de identidade.
func (s *Server) oidcLogin(w http.ResponseWriter, r *http.Request) {
	if s.opts.OIDC == nil {
		http.NotFound(w, r)
		return
	}
	authURL, state, err := s.opts.OIDC.AuthURL(r.Context(), safeReturnPath(r.URL.Query().Get("return")))
	if err != nil {
		s.log.Error("login OIDC indisponível", "erro", err)
		loginFailed(w, r, "oidc_unavailable")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: oidcStateCookie, Value: state, Path: "/auth/oidc", MaxAge: 600,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, authURL, http.StatusFound)
}

// oidcCallback recebe a volta do provedor, confere tudo e abre a sessão.
func (s *Server) oidcCallback(w http.ResponseWriter, r *http.Request) {
	if s.opts.OIDC == nil {
		http.NotFound(w, r)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: oidcStateCookie, Value: "", Path: "/auth/oidc", MaxAge: -1,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		s.log.Warn("login OIDC recusado pelo provedor", "erro", e, "descricao", q.Get("error_description"), "origem", clientIP(r))
		loginFailed(w, r, "oidc_denied")
		return
	}
	var cookieState string
	if c, err := r.Cookie(oidcStateCookie); err == nil {
		cookieState = c.Value
	}
	user, tokens, returnTo, err := s.opts.OIDC.Exchange(r.Context(), q.Get("state"), cookieState, q.Get("code"))
	if err != nil {
		s.log.Warn("login OIDC falhou", "erro", err, "origem", clientIP(r))
		switch {
		case errors.Is(err, auth.ErrOIDCState):
			loginFailed(w, r, "oidc_state")
		case errors.Is(err, auth.ErrOIDCClaims):
			loginFailed(w, r, "oidc_claims")
		default:
			loginFailed(w, r, "oidc_failed")
		}
		return
	}

	// Confirma com o cluster quem a sessão será. No modo token, a identidade
	// é a que o API server reconhece no ID token.
	who, err := s.whoAmI(r.Context(), s.oidcRESTConfig(user, tokens.IDToken))
	switch {
	case errors.Is(err, auth.ErrInvalidCredentials):
		s.log.Warn("login OIDC: o cluster não aceitou o ID token (o API server confia neste provedor?)", "usuario", user.Username)
		loginFailed(w, r, "oidc_cluster")
		return
	case apierrors.IsForbidden(err):
		s.log.Error("login OIDC: o KubeViz não tem permissão de impersonation", "usuario", user.Username, "erro", err)
		loginFailed(w, r, "oidc_impersonate")
		return
	case err != nil:
		s.log.Warn("login OIDC: cluster inacessível", "erro", err)
		loginFailed(w, r, "oidc_failed")
		return
	}
	if s.opts.OIDC.Config().Mode == auth.OIDCToken {
		user = who
	}

	sess := s.sessions.CreateFunc(user, "", func(sess *auth.Session) {
		sess.OIDC = tokens
		// Sem refresh token, a sessão acaba junto com o ID token.
		if tokens.RefreshToken == "" && tokens.Expiry.Before(sess.Expires) {
			sess.Expires = tokens.Expiry
		}
	})
	s.setSessionCookie(w, r, sess)
	s.log.Info("login OIDC", "usuario", user.Username, "grupos", strings.Join(user.Groups, ","), "origem", clientIP(r))
	http.Redirect(w, r, returnTo, http.StatusSeeOther)
}

// oidcRESTConfig é a credencial de uma sessão OIDC: o ID token repassado
// (modo token) ou a credencial do KubeViz agindo como o usuário (impersonate).
func (s *Server) oidcRESTConfig(user auth.User, idToken string) *rest.Config {
	if s.opts.OIDC.Config().Mode == auth.OIDCToken {
		return s.cluster.ConfigForToken(idToken)
	}
	cfg := s.cluster.RESTConfig()
	cfg.Impersonate = rest.ImpersonationConfig{UserName: user.Username, Groups: user.Groups}
	return cfg
}

// loginFailed volta para a tela de login com o motivo (a UI traduz).
func loginFailed(w http.ResponseWriter, r *http.Request, code string) {
	http.Redirect(w, r, "/?loginError="+url.QueryEscape(code), http.StatusSeeOther)
}

// safeReturnPath aceita só caminhos locais, para que o login não sirva de
// redirecionador para outros sites.
func safeReturnPath(p string) string {
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.HasPrefix(p, "/\\") || strings.ContainsAny(p, "\r\n") {
		return "/"
	}
	return p
}
