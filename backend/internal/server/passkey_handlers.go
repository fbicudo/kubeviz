package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

// Uma cerimônia WebAuthn (cadastro ou login) precisa ser concluída em pouco tempo.
const ceremonyTTL = 5 * time.Minute

// ceremonies guarda os desafios em andamento, de uso único.
type ceremonies struct {
	mu      sync.Mutex
	pending map[string]ceremony
}

type ceremony struct {
	data    webauthn.SessionData
	account string // cadastro: a conta; login: vazio
	session string // cadastro: a sessão que pediu
	expires time.Time
}

func (c *ceremonies) put(cer ceremony) string {
	id := auth.RandomToken()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pending == nil {
		c.pending = map[string]ceremony{}
	}
	now := time.Now()
	for k, v := range c.pending {
		if now.After(v.expires) {
			delete(c.pending, k)
		}
	}
	cer.expires = now.Add(ceremonyTTL)
	c.pending[id] = cer
	return id
}

// take devolve e apaga a cerimônia (uso único).
func (c *ceremonies) take(id string) (ceremony, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cer, ok := c.pending[id]
	delete(c.pending, id)
	if !ok || time.Now().After(cer.expires) {
		return ceremony{}, false
	}
	return cer, true
}

var errPasskeyHost = errors.New("passkeys exigem acessar o KubeViz por um nome (ex.: localhost ou 10.0.0.5.nip.io), não por endereço IP")

// passkeysEnabled: passkeys valem para as contas locais.
func (s *Server) passkeysEnabled() bool {
	return s.cluster.Mode() == cluster.ModeLocal && s.opts.Users != nil
}

// relyingParty configura o WebAuthn para o endereço pelo qual a pessoa acessa:
// a passkey fica ligada a esse nome. Endereços IP não servem (o navegador
// recusa).
func relyingParty(r *http.Request) (*webauthn.WebAuthn, error) {
	host := r.Host
	if h, _, err := net.SplitHostPort(r.Host); err == nil {
		host = h
	}
	if host == "" || net.ParseIP(host) != nil {
		return nil, errPasskeyHost
	}
	scheme := "http"
	if isHTTPS(r) {
		scheme = "https"
	}
	return webauthn.New(&webauthn.Config{
		RPID:          host,
		RPDisplayName: "KubeViz",
		RPOrigins:     []string{scheme + "://" + r.Host},
	})
}

type ceremonyResponse struct {
	Ceremony string `json:"ceremony"`
	Options  any    `json:"options"`
}

type ceremonyRequest struct {
	Ceremony   string          `json:"ceremony"`
	Name       string          `json:"name"`
	Credential json.RawMessage `json:"credential"`
}

func decodeCeremony(w http.ResponseWriter, r *http.Request) (ceremonyRequest, bool) {
	var req ceremonyRequest
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Ceremony == "" || len(req.Credential) == 0 {
		writeError(w, http.StatusBadRequest, "corpo inválido")
		return req, false
	}
	return req, true
}

// passkeyLoginBegin inicia o login sem usuário: o navegador oferece as
// passkeys deste endereço e a pessoa confirma no dispositivo.
func (s *Server) passkeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	if !s.passkeysEnabled() {
		writeError(w, http.StatusNotFound, "passkeys não estão habilitadas")
		return
	}
	rp, err := relyingParty(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	options, data, err := rp.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ceremonyResponse{Ceremony: s.passkeys.put(ceremony{data: *data}), Options: options})
}

// passkeyLoginFinish confere a assinatura do dispositivo e abre a sessão da conta.
func (s *Server) passkeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	if !s.passkeysEnabled() {
		writeError(w, http.StatusNotFound, "passkeys não estão habilitadas")
		return
	}
	key := "passkey-ip:" + clientIP(r)
	if blocked, wait := s.limiter.Blocked(key); blocked {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "muitas tentativas; tente novamente mais tarde")
		return
	}
	req, ok := decodeCeremony(w, r)
	if !ok {
		return
	}
	fail := func(reason string, err error) {
		s.limiter.Fail(key)
		s.log.Warn("login com passkey recusado", "motivo", reason, "erro", err, "origem", clientIP(r))
		writeError(w, http.StatusUnauthorized, "passkey não reconhecida")
	}
	cer, ok := s.passkeys.take(req.Ceremony)
	if !ok || cer.account != "" {
		fail("desafio expirado ou inválido", nil)
		return
	}
	rp, err := relyingParty(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBody(bytes.NewReader(req.Credential))
	if err != nil {
		fail("resposta inválida", err)
		return
	}
	var account string
	handler := func(_, userHandle []byte) (webauthn.User, error) {
		acc, ok := s.opts.Users.ByWebAuthnID(userHandle)
		if !ok {
			return nil, auth.ErrUserNotFound
		}
		account = acc.Name
		return auth.WebAuthnUser{Account: acc}, nil
	}
	_, cred, err := rp.ValidatePasskeyLogin(handler, cer.data, parsed)
	if err != nil {
		fail("assinatura inválida ou passkey desconhecida", err)
		return
	}
	if cred.Authenticator.CloneWarning {
		fail("contador de uso voltou atrás (possível passkey clonada)", nil)
		return
	}
	s.limiter.Reset(key)
	if err := s.opts.Users.PasskeyUsed(account, *cred); err != nil {
		s.log.Warn("atualizando a passkey", "usuario", account, "erro", err)
	}
	sess := s.sessions.Create(auth.User{}, "")
	sess.LocalUser = account
	s.setSessionCookie(w, r, sess)
	s.log.Info("login com passkey", "usuario", account, "origem", clientIP(r))
	writeJSON(w, http.StatusOK, s.sessionInfo(r, sess))
}

// requireAccount: rotas da própria conta (Minha conta), só para contas locais.
func (s *Server) requireAccount(next http.HandlerFunc) http.HandlerFunc {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		sess := sessionFrom(r.Context())
		if !s.passkeysEnabled() || sess.LocalUser == "" {
			writeError(w, http.StatusNotFound, "disponível só para contas do KubeViz")
			return
		}
		next(w, r)
	})
}

type passkeyView struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Created  time.Time `json:"created"`
	LastUsed time.Time `json:"lastUsed,omitzero"`
	Synced   bool      `json:"synced"`
}

func (s *Server) listPasskeys(w http.ResponseWriter, r *http.Request) {
	acc, _ := s.opts.Users.Get(sessionFrom(r.Context()).LocalUser)
	views := []passkeyView{}
	for _, p := range acc.Passkeys {
		views = append(views, passkeyView{ID: p.PasskeyID(), Name: p.Name, Created: p.Created, LastUsed: p.LastUsed, Synced: p.Credential.Flags.BackupState})
	}
	writeJSON(w, http.StatusOK, map[string]any{"passkeys": views})
}

// passkeyRegisterBegin inicia o cadastro de uma passkey para a própria conta.
func (s *Server) passkeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	rp, err := relyingParty(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	user, err := s.opts.Users.WebAuthnUserFor(sess.LocalUser)
	if err != nil {
		writeAccountError(w, err)
		return
	}
	// Exclui as passkeys já cadastradas: o mesmo dispositivo não entra duas vezes.
	var exclude []protocol.CredentialDescriptor
	for _, c := range user.WebAuthnCredentials() {
		exclude = append(exclude, c.Descriptor())
	}
	options, data, err := rp.BeginRegistration(user,
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithExclusions(exclude),
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	id := s.passkeys.put(ceremony{data: *data, account: sess.LocalUser, session: sess.ID})
	writeJSON(w, http.StatusOK, ceremonyResponse{Ceremony: id, Options: options})
}

func (s *Server) passkeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	req, ok := decodeCeremony(w, r)
	if !ok {
		return
	}
	cer, ok := s.passkeys.take(req.Ceremony)
	if !ok || cer.account != sess.LocalUser || cer.session != sess.ID {
		writeError(w, http.StatusBadRequest, "o cadastro expirou; tente de novo")
		return
	}
	rp, err := relyingParty(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(req.Credential))
	if err != nil {
		writeError(w, http.StatusBadRequest, "resposta do dispositivo inválida")
		return
	}
	user, err := s.opts.Users.WebAuthnUserFor(sess.LocalUser)
	if err != nil {
		writeAccountError(w, err)
		return
	}
	cred, err := rp.CreateCredential(user, cer.data, parsed)
	if err != nil {
		s.log.Warn("cadastro de passkey recusado", "usuario", sess.LocalUser, "erro", err)
		writeError(w, http.StatusBadRequest, "o dispositivo não confirmou a passkey")
		return
	}
	err = s.opts.Users.AddPasskey(sess.LocalUser, auth.Passkey{Name: req.Name, Created: time.Now().UTC().Truncate(time.Second), Credential: *cred})
	switch {
	case errors.Is(err, auth.ErrPasskeyExists), errors.Is(err, auth.ErrTooManyPasskeys):
		writeError(w, http.StatusConflict, err.Error())
		return
	case err != nil:
		writeAccountError(w, err)
		return
	}
	s.log.Info("passkey cadastrada", "usuario", sess.LocalUser, "nome", req.Name, "origem", clientIP(r))
	w.WriteHeader(http.StatusCreated)
}

func (s *Server) deletePasskey(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if err := s.opts.Users.RemovePasskey(sess.LocalUser, r.PathValue("id")); err != nil {
		if errors.Is(err, auth.ErrPasskeyNotFound) {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeAccountError(w, err)
		return
	}
	s.log.Info("passkey removida", "usuario", sess.LocalUser, "origem", clientIP(r))
	w.WriteHeader(http.StatusNoContent)
}
