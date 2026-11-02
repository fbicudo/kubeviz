package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/auth/webauthntest"
)

// passkeyDo faz um pedido como se o navegador acessasse http://localhost:4466.
func passkeyDo(t *testing.T, h http.Handler, method, target, body, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Host = "localhost:4466"
	req.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

const origin = "http://localhost:4466"

func ceremonyOf(t *testing.T, rec *httptest.ResponseRecorder) (string, []byte) {
	t.Helper()
	if rec.Code != 200 {
		t.Fatalf("início da cerimônia: %d %s", rec.Code, rec.Body)
	}
	var c struct {
		Ceremony string          `json:"ceremony"`
		Options  json.RawMessage `json:"options"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &c)
	return c.Ceremony, c.Options
}

func finishBody(ceremony, name string, cred []byte) string {
	b, _ := json.Marshal(map[string]any{"ceremony": ceremony, "name": name, "credential": json.RawMessage(cred)})
	return string(b)
}

func TestPasskeys(t *testing.T) {
	users := auth.NewUsers(filepath.Join(t.TempDir(), "users"))
	h := newServer(newFakeCluster(), Options{Users: users}).Handler()
	_, cookie := setupAccount(t, h, "fabio", testPassword)
	dev := webauthntest.New(t)

	if s := sessionOf(t, h, ""); !s.Passkeys {
		t.Fatal("a tela de login deveria oferecer passkey")
	}

	// Cadastro pela própria conta.
	cer, opts := ceremonyOf(t, passkeyDo(t, h, "POST", "/api/v1/me/passkeys/begin", "{}", cookie))
	if !strings.Contains(string(opts), `"residentKey":"required"`) || !strings.Contains(string(opts), `"userVerification":"required"`) {
		t.Errorf("a passkey deve ser residente e com verificação do usuário: %s", opts)
	}
	if rec := passkeyDo(t, h, "POST", "/api/v1/me/passkeys/finish", finishBody(cer, "Notebook", dev.Create(opts, origin)), cookie); rec.Code != 201 {
		t.Fatalf("cadastro: %d %s", rec.Code, rec.Body)
	}
	// O desafio é de uso único.
	if rec := passkeyDo(t, h, "POST", "/api/v1/me/passkeys/finish", finishBody(cer, "De novo", dev.Create(opts, origin)), cookie); rec.Code != 400 {
		t.Errorf("desafio reutilizado: %d", rec.Code)
	}
	rec := passkeyDo(t, h, "GET", "/api/v1/me/passkeys", "", cookie)
	var list struct {
		Passkeys []passkeyView `json:"passkeys"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list.Passkeys) != 1 || list.Passkeys[0].Name != "Notebook" {
		t.Fatalf("lista: %s", rec.Body)
	}

	// Login sem usuário nem senha.
	cer, opts = ceremonyOf(t, passkeyDo(t, h, "POST", "/api/v1/auth/passkey/begin", "{}", ""))
	rec = passkeyDo(t, h, "POST", "/api/v1/auth/passkey/finish", finishBody(cer, "", dev.Get(opts, origin)), "")
	if rec.Code != 200 {
		t.Fatalf("login com passkey: %d %s", rec.Code, rec.Body)
	}
	_, newCookie := cookieFrom(t, rec)
	if s := sessionOf(t, h, newCookie); s.LocalUser != "fabio" || !s.Admin {
		t.Errorf("sessão: %+v", s)
	}
	if acc, _ := users.Get("fabio"); acc.Passkeys[0].LastUsed.IsZero() || acc.Passkeys[0].Credential.Authenticator.SignCount != 1 {
		t.Errorf("uso não registrado: %+v", acc.Passkeys[0])
	}

	// Outro site (origem diferente) não consegue usar a assinatura.
	cer, opts = ceremonyOf(t, passkeyDo(t, h, "POST", "/api/v1/auth/passkey/begin", "{}", ""))
	if rec := passkeyDo(t, h, "POST", "/api/v1/auth/passkey/finish", finishBody(cer, "", dev.Get(opts, "https://evil.example")), ""); rec.Code != 401 {
		t.Errorf("origem falsa: %d", rec.Code)
	}
	// Contador de uso que volta atrás: possível passkey clonada.
	dev.Count = 0
	cer, opts = ceremonyOf(t, passkeyDo(t, h, "POST", "/api/v1/auth/passkey/begin", "{}", ""))
	if rec := passkeyDo(t, h, "POST", "/api/v1/auth/passkey/finish", finishBody(cer, "", dev.Get(opts, origin)), ""); rec.Code != 401 {
		t.Errorf("contador voltou atrás: %d", rec.Code)
	}

	// Remover: a passkey deixa de entrar.
	if rec := passkeyDo(t, h, "DELETE", "/api/v1/me/passkeys/"+list.Passkeys[0].ID, "", cookie); rec.Code != 204 {
		t.Fatalf("remover: %d", rec.Code)
	}
	dev.Count = 10
	cer, opts = ceremonyOf(t, passkeyDo(t, h, "POST", "/api/v1/auth/passkey/begin", "{}", ""))
	if rec := passkeyDo(t, h, "POST", "/api/v1/auth/passkey/finish", finishBody(cer, "", dev.Get(opts, origin)), ""); rec.Code != 401 {
		t.Errorf("passkey removida entrou: %d", rec.Code)
	}
}

func TestPasskeysNeedHostName(t *testing.T) {
	users := auth.NewUsers(filepath.Join(t.TempDir(), "users"))
	h := newServer(newFakeCluster(), Options{Users: users}).Handler()
	// do() usa Host 127.0.0.1:4466: endereço IP não serve para passkeys.
	rec := do(t, h, "POST", "/api/v1/auth/passkey/begin", "{}", jsonHeaders)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "nome") {
		t.Errorf("por IP: %d %s", rec.Code, rec.Body)
	}
	// Sem conta local (link do terminal), não há Minha conta.
	sess := loggedIn(newServer(newFakeCluster(), Options{Users: users}), "")
	if rec := passkeyDo(t, h, "GET", "/api/v1/me/passkeys", "", sess); rec.Code != 401 && rec.Code != 404 {
		t.Errorf("sem conta local: %d", rec.Code)
	}
}
