package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

func signup(t *testing.T, h http.Handler, code, user, pass string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"code": code, "username": user, "password": pass})
	rec := do(t, h, "POST", "/api/v1/auth/signup", string(body), jsonHeaders)
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie {
			return rec.Code, c.Name + "=" + c.Value
		}
	}
	return rec.Code, ""
}

func TestSignup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users")
	users := auth.NewUsers(path)
	h := newServer(newFakeCluster(), Options{LocalToken: "codigo-do-terminal", Users: users}).Handler()

	// Sem contas: entra-se pelo link, e a tela oferece criar conta.
	if s := sessionOf(t, h, ""); !s.Signup || len(s.LoginMethods) != 1 || s.LoginMethods[0] != "link" {
		t.Fatalf("antes: %+v", s)
	}

	if code, cookie := signup(t, h, "codigo-errado", "ana", testPassword); code != 401 || cookie != "" {
		t.Errorf("código errado: %d, cookie %q", code, cookie)
	}
	if code, _ := signup(t, h, "codigo-do-terminal", "Ana Maria", testPassword); code != 400 {
		t.Errorf("nome inválido: %d", code)
	}
	if code, _ := signup(t, h, "codigo-do-terminal", "ana", "curta"); code != 400 {
		t.Errorf("senha curta: %d", code)
	}

	// O link inteiro do terminal também serve de código; a conta já entra.
	code, cookie := signup(t, h, "http://127.0.0.1:4466/auth/local?token=codigo-do-terminal", "Ana", testPassword)
	if code != 200 || cookie == "" {
		t.Fatalf("criar conta: %d", code)
	}
	if s := sessionOf(t, h, cookie); !s.Authenticated || s.LocalUser != "ana" {
		t.Errorf("sessão: %+v", s)
	}
	// Com uma conta, o login passa a ser por senha; a senha nova vale.
	if s := sessionOf(t, h, ""); len(s.LoginMethods) != 1 || s.LoginMethods[0] != "password" || !s.Signup {
		t.Errorf("depois: %+v", s)
	}
	if code, _, _ := login(t, h, "ana", testPassword); code != 200 {
		t.Errorf("login com a conta nova: %d", code)
	}

	// Ninguém troca a senha de uma conta existente "criando" de novo.
	if code, _ := signup(t, h, "codigo-do-terminal", "ana", "outra-senha-bem-comprida"); code != 409 {
		t.Errorf("nome repetido: %d, quer 409", code)
	}
	if code, _, _ := login(t, h, "ana", testPassword); code != 200 {
		t.Errorf("a senha original deveria continuar valendo: %d", code)
	}
}

func TestSignupLockout(t *testing.T) {
	h := newServer(newFakeCluster(), Options{LocalToken: "codigo", Users: auth.NewUsers(filepath.Join(t.TempDir(), "users"))}).Handler()
	for i := range 5 {
		if code, _ := signup(t, h, fmt.Sprintf("errado-%d", i), "ana", testPassword); code != 401 {
			t.Fatalf("tentativa %d: %d", i, code)
		}
	}
	// Bloqueado mesmo com o código certo.
	if code, _ := signup(t, h, "codigo", "ana", testPassword); code != 429 {
		t.Errorf("após 5 erros: %d, quer 429", code)
	}
}

func TestSignupDisabledInCluster(t *testing.T) {
	fc := newFakeCluster()
	fc.mode = cluster.ModeInCluster
	h := newServer(fc, Options{}).Handler()
	if s := sessionOf(t, h, ""); s.Signup {
		t.Error("in-cluster não deveria oferecer criar conta")
	}
	if code, _ := signup(t, h, "x", "ana", testPassword); code != 404 {
		t.Errorf("signup in-cluster: %d, quer 404", code)
	}
}
