package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

// providerStateCookie liga a volta do provedor ao navegador que iniciou o
// login. SameSite=Lax: a volta do provedor é uma navegação de outro site.
const providerStateCookie = "kubeviz_provider_state"

// providersEnabled: login por provedores existe no modo local, com contas.
func (s *Server) providersEnabled() bool {
	return s.cluster.Mode() == cluster.ModeLocal && s.opts.Users != nil && s.opts.Providers != nil
}

func (s *Server) providerConfig(id string) (auth.ProviderConfig, bool) {
	if !s.providersEnabled() {
		return auth.ProviderConfig{}, false
	}
	for _, p := range s.opts.Users.Snapshot().Providers {
		if p.ID == id {
			return p, true
		}
	}
	return auth.ProviderConfig{}, false
}

// providerCallbackURL é o endereço de retorno registrado no provedor, montado
// a partir do endereço pelo qual a pessoa acessa o KubeViz.
func providerCallbackURL(r *http.Request, id string) string {
	scheme := "http"
	if isHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host + "/auth/provider/" + id + "/callback"
}

type providerButton struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Name string `json:"name"`
}

// loginProviders são os botões da tela de login.
func (s *Server) loginProviders() []providerButton {
	if !s.providersEnabled() {
		return nil
	}
	var out []providerButton
	for _, p := range s.opts.Users.Snapshot().Providers {
		out = append(out, providerButton{ID: p.ID, Type: p.Type, Name: p.Name})
	}
	return out
}

func (s *Server) providerLogin(w http.ResponseWriter, r *http.Request) {
	p, ok := s.providerConfig(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	authURL, state, err := s.opts.Providers.AuthURL(r.Context(), p, providerCallbackURL(r, p.ID), safeReturnPath(r.URL.Query().Get("return")))
	if err != nil {
		s.log.Error("login por provedor indisponível", "provedor", p.ID, "erro", err)
		loginFailed(w, r, "provider_unavailable")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: providerStateCookie, Value: state, Path: "/auth/provider", MaxAge: 600,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, authURL, http.StatusFound)
}

func (s *Server) providerCallback(w http.ResponseWriter, r *http.Request) {
	p, ok := s.providerConfig(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: providerStateCookie, Value: "", Path: "/auth/provider", MaxAge: -1,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		s.log.Warn("login recusado pelo provedor", "provedor", p.ID, "erro", e, "descricao", q.Get("error_description"), "origem", clientIP(r))
		loginFailed(w, r, "provider_denied")
		return
	}
	var cookieState string
	if c, err := r.Cookie(providerStateCookie); err == nil {
		cookieState = c.Value
	}
	email, returnTo, err := s.opts.Providers.Identify(r.Context(), p, q.Get("state"), cookieState, q.Get("code"))
	if err != nil {
		s.log.Warn("login por provedor falhou", "provedor", p.ID, "erro", err, "origem", clientIP(r))
		switch {
		case errors.Is(err, auth.ErrOIDCState):
			loginFailed(w, r, "provider_state")
		case errors.Is(err, auth.ErrUnverifiedEmail):
			loginFailed(w, r, "provider_email")
		default:
			loginFailed(w, r, "provider_failed")
		}
		return
	}
	acc, created, err := s.opts.Users.ForEmail(email)
	if err != nil {
		s.log.Warn("login por provedor recusado: e-mail sem conta", "provedor", p.ID, "email", email, "origem", clientIP(r))
		loginFailed(w, r, "provider_unauthorized")
		return
	}
	sess := s.sessions.Create(auth.User{}, "")
	sess.LocalUser = acc.Name
	s.setSessionCookie(w, r, sess)
	if created {
		s.log.Info("conta criada no primeiro acesso por provedor (domínio liberado)", "usuario", acc.Name, "email", email, "provedor", p.ID)
	}
	s.log.Info("login por provedor", "usuario", acc.Name, "email", email, "provedor", p.ID, "origem", clientIP(r))
	http.Redirect(w, r, returnTo, http.StatusSeeOther)
}

// providerView é o provedor como a interface de administração o vê (sem o secret).
type providerView struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Name      string `json:"name"`
	ClientID  string `json:"clientId"`
	HasSecret bool   `json:"hasSecret"`
	IssuerURL string `json:"issuerUrl,omitempty"`
	Tenant    string `json:"tenant,omitempty"`
}

func (s *Server) listProviders(w http.ResponseWriter, r *http.Request) {
	views := []providerView{}
	for _, p := range s.opts.Users.Snapshot().Providers {
		views = append(views, providerView{ID: p.ID, Type: p.Type, Name: p.Name, ClientID: p.ClientID, HasSecret: p.ClientSecret != "", IssuerURL: p.IssuerURL, Tenant: p.Tenant})
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": views})
}

// putProvider cria ou altera um provedor; secret vazio mantém o atual.
func (s *Server) putProvider(w http.ResponseWriter, r *http.Request) {
	var p auth.ProviderConfig
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeError(w, http.StatusBadRequest, "corpo inválido")
		return
	}
	p.ID = r.PathValue("id")
	current := s.opts.Users.Snapshot().Providers
	if i := slices.IndexFunc(current, func(c auth.ProviderConfig) bool { return c.ID == p.ID }); i >= 0 && p.ClientSecret == "" {
		p.ClientSecret = current[i].ClientSecret
	}
	p, err := p.Normalize()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if p.ID != r.PathValue("id") {
		writeError(w, http.StatusBadRequest, "o identificador de "+p.Type+" é "+p.Type)
		return
	}
	next := slices.DeleteFunc(slices.Clone(current), func(c auth.ProviderConfig) bool { return c.ID == p.ID })
	next = append(next, p)
	slices.SortFunc(next, func(a, b auth.ProviderConfig) int { return providerOrder(a) - providerOrder(b) })
	if err := s.opts.Users.SetProviders(next); err != nil {
		writeError(w, http.StatusInternalServerError, "não foi possível salvar: "+err.Error())
		return
	}
	s.log.Info("provedor de login salvo", "provedor", p.ID, "tipo", p.Type, "por", sessionUser(sessionFrom(r.Context())))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteProvider(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	current := s.opts.Users.Snapshot().Providers
	next := slices.DeleteFunc(slices.Clone(current), func(c auth.ProviderConfig) bool { return c.ID == id })
	if len(next) == len(current) {
		writeError(w, http.StatusNotFound, "provedor não encontrado")
		return
	}
	if err := s.opts.Users.SetProviders(next); err != nil {
		writeError(w, http.StatusInternalServerError, "não foi possível salvar: "+err.Error())
		return
	}
	s.log.Info("provedor de login removido", "provedor", id, "por", sessionUser(sessionFrom(r.Context())))
	w.WriteHeader(http.StatusNoContent)
}

// providerOrder: Google, Microsoft, GitHub e depois os OIDC.
func providerOrder(p auth.ProviderConfig) int {
	return slices.Index([]string{auth.ProviderGoogle, auth.ProviderMicrosoft, auth.ProviderGitHub, auth.ProviderOIDC}, p.Type)
}
