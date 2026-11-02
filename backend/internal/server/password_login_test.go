package server

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

// Senhas geradas só para os testes.
const (
	testUser     = "fabio"
	testPassword = "senha-de-teste-com-tamanho"
)

func passwordServer(t *testing.T, fc *fakeCluster) (http.Handler, *auth.Users) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "users")
	if err := auth.SetUser(path, testUser, testPassword); err != nil {
		t.Fatal(err)
	}
	users := auth.NewUsers(path)
	return newServer(fc, Options{LocalToken: "segredo", Users: users}).Handler(), users
}

func login(t *testing.T, h http.Handler, user, pass string, extra ...string) (int, string, sessionResponse) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": user, "password": pass})
	rec := do(t, h, "POST", "/api/v1/auth/password", string(body), with(jsonHeaders, extra...))
	var s sessionResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &s)
	cookie := ""
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie {
			cookie = c.Name + "=" + c.Value
		}
	}
	return rec.Code, cookie, s
}

func TestPasswordLogin(t *testing.T) {
	h, _ := passwordServer(t, newFakeCluster())

	if s := sessionOf(t, h, ""); len(s.LoginMethods) != 1 || s.LoginMethods[0] != "password" {
		t.Fatalf("métodos de login = %v, quer [password]", s.LoginMethods)
	}
	// Com contas criadas, o link com token deixa de valer: mesmo com o token
	// certo, só redireciona para a tela de login, sem criar sessão.
	rec := do(t, h, "GET", "/auth/local?token=segredo", "", nil)
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/" || len(rec.Result().Cookies()) != 0 {
		t.Errorf("link com token: status %d, Location %q, cookies %v", rec.Code, rec.Header().Get("Location"), rec.Result().Cookies())
	}

	if code, cookie, _ := login(t, h, testUser, "senha-errada-de-teste"); code != 401 || cookie != "" {
		t.Fatalf("senha errada: %d, cookie %q", code, cookie)
	}
	if code, _, _ := login(t, h, "ninguem", testPassword); code != 401 {
		t.Fatalf("usuário inexistente: %d", code)
	}

	code, cookie, s := login(t, h, "  FABIO ", testPassword) // espaços e maiúsculas ignorados
	if code != 200 || cookie == "" || s.LocalUser != testUser {
		t.Fatalf("login: %d, cookie %q, sessão %+v", code, cookie, s)
	}
	if s := sessionOf(t, h, cookie); !s.Authenticated || s.LocalUser != testUser || s.User == nil {
		t.Fatalf("sessão após login: %+v", s)
	}
	// A sessão dá acesso às rotas protegidas.
	if rec := do(t, h, "GET", "/api/v1/cluster", "", map[string]string{"Cookie": cookie}); rec.Code != 200 {
		t.Errorf("rota protegida com sessão: %d", rec.Code)
	}
}

func TestPasswordLoginLockout(t *testing.T) {
	h, _ := passwordServer(t, newFakeCluster())
	for i := 0; i < 5; i++ {
		if code, _, _ := login(t, h, testUser, "errada-numero-tentativa"); code != 401 {
			t.Fatalf("tentativa %d: %d", i+1, code)
		}
	}
	// Bloqueado mesmo com a senha certa, até a janela passar.
	rec := do(t, h, "POST", "/api/v1/auth/password", `{"username":"fabio","password":"`+testPassword+`"}`, jsonHeaders)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("após 5 erros: status %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestPasswordLoginDisabled(t *testing.T) {
	// Sem contas: continua o link com token.
	h := newServer(newFakeCluster(), Options{LocalToken: "segredo", Users: auth.NewUsers(filepath.Join(t.TempDir(), "users"))}).Handler()
	if s := sessionOf(t, h, ""); s.LoginMethods[0] != "link" {
		t.Fatalf("métodos = %v, quer [link]", s.LoginMethods)
	}
	if code, _, _ := login(t, h, testUser, testPassword); code != 404 {
		t.Errorf("login por senha sem contas: %d, quer 404", code)
	}

	// Modo in-cluster: login por token; contas locais não se aplicam.
	fc := newFakeCluster()
	fc.mode = cluster.ModeInCluster
	h, _ = passwordServer(t, fc)
	if s := sessionOf(t, h, ""); s.LoginMethods[0] != "token" {
		t.Fatalf("in-cluster: métodos = %v", s.LoginMethods)
	}
	if code, _, _ := login(t, h, testUser, testPassword); code != 404 {
		t.Errorf("in-cluster, login por senha: %d, quer 404", code)
	}
}
