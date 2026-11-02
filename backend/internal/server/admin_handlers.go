package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

// isAdmin: contas administradoras e, sem nenhuma conta, quem entrou pelo link
// do terminal (o dono da máquina).
func (s *Server) isAdmin(sess *auth.Session) bool {
	if sess == nil || s.cluster.Mode() != cluster.ModeLocal || s.opts.Users == nil || sess.OIDC != nil {
		return false
	}
	if sess.LocalUser == "" {
		return true
	}
	acc, ok := s.opts.Users.Get(sess.LocalUser)
	return ok && acc.Admin
}

// requireAdmin recusa quem não é administrador (o papel é conferido a cada
// pedido: rebaixar alguém vale na hora).
func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdmin(sessionFrom(r.Context())) {
			writeError(w, http.StatusForbidden, "apenas administradores do KubeViz")
			return
		}
		next(w, r)
	})
}

// accountView é a conta como a interface a vê (sem o hash da senha).
type accountView struct {
	Name        string    `json:"name"`
	Admin       bool      `json:"admin"`
	HasPassword bool      `json:"hasPassword"`
	Emails      []string  `json:"emails"`
	Created     time.Time `json:"created,omitzero"`
	Current     bool      `json:"current,omitempty"`
}

func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	d := s.opts.Users.Snapshot()
	views := make([]accountView, 0, len(d.Accounts))
	for _, a := range d.Accounts {
		emails := a.Emails
		if emails == nil {
			emails = []string{}
		}
		views = append(views, accountView{
			Name: a.Name, Admin: a.Admin, HasPassword: a.HasPassword(), Emails: emails,
			Created: a.Created, Current: a.Name == sess.LocalUser,
		})
	}
	domains := d.AllowedDomains
	if domains == nil {
		domains = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": views, "allowedDomains": domains})
}

type accountRequest struct {
	Name           string    `json:"name"`
	Password       *string   `json:"password"`
	RemovePassword bool      `json:"removePassword"`
	Admin          *bool     `json:"admin"`
	Emails         *[]string `json:"emails"`
}

func decodeAccount(w http.ResponseWriter, r *http.Request) (accountRequest, bool) {
	var req accountRequest
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "corpo inválido")
		return req, false
	}
	return req, true
}

func (s *Server) createAccount(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeAccount(w, r)
	if !ok {
		return
	}
	acc := auth.Account{Name: strings.ToLower(strings.TrimSpace(req.Name))}
	if req.Admin != nil {
		acc.Admin = *req.Admin
	}
	if req.Emails != nil {
		acc.Emails = *req.Emails
	}
	password := ""
	if req.Password != nil {
		password = *req.Password
	}
	if err := s.opts.Users.Create(acc, password); err != nil {
		writeAccountError(w, err)
		return
	}
	s.log.Info("conta criada", "usuario", acc.Name, "admin", acc.Admin, "por", sessionUser(sessionFrom(r.Context())))
	w.WriteHeader(http.StatusCreated)
}

func (s *Server) updateAccount(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeAccount(w, r)
	if !ok {
		return
	}
	name := r.PathValue("name")
	err := s.opts.Users.Update(name, auth.AccountChanges{
		Password: req.Password, RemovePassword: req.RemovePassword, Admin: req.Admin, Emails: req.Emails,
	})
	if err != nil {
		writeAccountError(w, err)
		return
	}
	s.log.Info("conta alterada", "usuario", name, "por", sessionUser(sessionFrom(r.Context())))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.opts.Users.Remove(name); err != nil {
		writeAccountError(w, err)
		return
	}
	s.log.Info("conta removida", "usuario", name, "por", sessionUser(sessionFrom(r.Context())))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) putDomains(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Domains []string `json:"domains"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "corpo inválido")
		return
	}
	if err := s.opts.Users.SetAllowedDomains(body.Domains); err != nil {
		writeAccountError(w, err)
		return
	}
	s.log.Info("domínios liberados alterados", "dominios", strings.Join(body.Domains, ","), "por", sessionUser(sessionFrom(r.Context())))
	w.WriteHeader(http.StatusNoContent)
}

// writeAccountError traduz os erros das contas em respostas HTTP.
func writeAccountError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrUserNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, auth.ErrUserExists), errors.Is(err, auth.ErrEmailInUse), errors.Is(err, auth.ErrLastAdmin):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, auth.ErrInvalidUsername), errors.Is(err, auth.ErrShortPassword), errors.Is(err, auth.ErrInvalidEmail),
		errors.Is(err, auth.ErrNoLoginMethod), errors.Is(err, auth.ErrInvalidDomain):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "não foi possível salvar: "+err.Error())
	}
}
