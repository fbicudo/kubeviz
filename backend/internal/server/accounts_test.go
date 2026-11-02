package server

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

func setupAccount(t *testing.T, h http.Handler, user, pass string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": user, "password": pass})
	rec := do(t, h, "POST", "/api/v1/auth/setup", string(body), jsonHeaders)
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie {
			return rec.Code, c.Name + "=" + c.Value
		}
	}
	return rec.Code, ""
}

func TestFirstAccountSetup(t *testing.T) {
	users := auth.NewUsers(filepath.Join(t.TempDir(), "users"))
	h := newServer(newFakeCluster(), Options{LocalToken: "tok", Users: users}).Handler()

	if s := sessionOf(t, h, ""); s.Setup != "available" {
		t.Fatalf("sem contas: setup = %q", s.Setup)
	}
	if code, _ := setupAccount(t, h, "fabio", "curta"); code != 400 {
		t.Errorf("senha curta: %d", code)
	}
	code, cookie := setupAccount(t, h, "Fabio", testPassword)
	if code != 200 || cookie == "" {
		t.Fatalf("primeira conta: %d", code)
	}
	if s := sessionOf(t, h, cookie); !s.Authenticated || s.LocalUser != "fabio" || !s.Admin {
		t.Errorf("sessão do administrador: %+v", s)
	}
	// Com uma conta, ninguém mais cria contas pela tela de login.
	if s := sessionOf(t, h, ""); s.Setup != "" || s.LoginMethods[0] != "password" {
		t.Errorf("depois: %+v", s)
	}
	if code, _ := setupAccount(t, h, "intruso", testPassword); code != 409 {
		t.Errorf("segunda conta pela tela de login: %d, quer 409", code)
	}
}

func TestFirstAccountSetupDeadline(t *testing.T) {
	users := auth.NewUsers(filepath.Join(t.TempDir(), "users"))
	h := newServer(newFakeCluster(), Options{Users: users, SetupUntil: time.Now().Add(-time.Second)}).Handler()
	if s := sessionOf(t, h, ""); s.Setup != "expired" {
		t.Fatalf("prazo vencido: setup = %q", s.Setup)
	}
	if code, _ := setupAccount(t, h, "fabio", testPassword); code != 403 {
		t.Errorf("criar após o prazo: %d, quer 403", code)
	}
	fc := newFakeCluster()
	fc.mode = cluster.ModeInCluster
	if s := sessionOf(t, newServer(fc, Options{}).Handler(), ""); s.Setup != "" {
		t.Errorf("in-cluster: setup = %q", s.Setup)
	}
}

func TestAccountAdministration(t *testing.T) {
	users := auth.NewUsers(filepath.Join(t.TempDir(), "users"))
	h := newServer(newFakeCluster(), Options{Users: users}).Handler()
	_, admin := setupAccount(t, h, "fabio", testPassword)
	as := func(cookie string) map[string]string { return with(jsonHeaders, "Cookie", cookie) }

	// Conta só com e-mail (entra pelo Google, por exemplo) e conta com senha.
	if rec := do(t, h, "POST", "/api/v1/admin/users", `{"name":"bia","emails":["Bia@Exemplo.com"]}`, as(admin)); rec.Code != 201 {
		t.Fatalf("criar bia: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, h, "POST", "/api/v1/admin/users", `{"name":"caio","password":"`+testPassword+`"}`, as(admin)); rec.Code != 201 {
		t.Fatalf("criar caio: %d %s", rec.Code, rec.Body)
	}
	for body, want := range map[string]int{
		`{"name":"bia","password":"` + testPassword + `"}`: 409, // nome repetido
		`{"name":"dani"}`: 400, // sem senha nem e-mail
		`{"name":"edu","emails":["bia@exemplo.com"]}`:          409, // e-mail de outra conta
		`{"name":"Fe Lima","password":"` + testPassword + `"}`: 400,
	} {
		if rec := do(t, h, "POST", "/api/v1/admin/users", body, as(admin)); rec.Code != want {
			t.Errorf("%s: %d, quer %d", body, rec.Code, want)
		}
	}
	rec := do(t, h, "GET", "/api/v1/admin/users", "", as(admin))
	var list struct {
		Accounts []accountView `json:"accounts"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list.Accounts) != 3 || list.Accounts[0].Name != "bia" || list.Accounts[0].HasPassword || list.Accounts[0].Emails[0] != "bia@exemplo.com" {
		t.Fatalf("lista: %s", rec.Body)
	}
	if body := rec.Body.String(); strings.Contains(body, "$2") || strings.Contains(body, "passwordHash") {
		t.Fatal("a lista não pode expor hashes de senha")
	}

	// Quem não é administrador não gerencia contas.
	_, caio, _ := login(t, h, "caio", testPassword)
	if s := sessionOf(t, h, caio); s.Admin {
		t.Error("caio não deveria ser administrador")
	}
	if rec := do(t, h, "GET", "/api/v1/admin/users", "", as(caio)); rec.Code != 403 {
		t.Errorf("não administrador listando: %d", rec.Code)
	}
	// Promovido, passa a poder na hora; removido, a sessão acaba na hora.
	if rec := do(t, h, "PUT", "/api/v1/admin/users/caio", `{"admin":true}`, as(admin)); rec.Code != 204 {
		t.Fatalf("promover: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, h, "GET", "/api/v1/admin/users", "", as(caio)); rec.Code != 200 {
		t.Errorf("promovido listando: %d", rec.Code)
	}
	if rec := do(t, h, "DELETE", "/api/v1/admin/users/caio", "", as(admin)); rec.Code != 204 {
		t.Fatalf("remover: %d", rec.Code)
	}
	if rec := do(t, h, "GET", "/api/v1/cluster", "", as(caio)); rec.Code != 401 {
		t.Errorf("sessão de conta removida: %d, quer 401", rec.Code)
	}
	// O último administrador fica.
	if rec := do(t, h, "PUT", "/api/v1/admin/users/fabio", `{"admin":false}`, as(admin)); rec.Code != 409 {
		t.Errorf("rebaixar o último admin: %d", rec.Code)
	}
	if rec := do(t, h, "PUT", "/api/v1/admin/domains", `{"domains":["empresa.com"]}`, as(admin)); rec.Code != 204 {
		t.Errorf("domínios: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, h, "PUT", "/api/v1/admin/domains", `{"domains":["não é domínio"]}`, as(admin)); rec.Code != 400 {
		t.Errorf("domínio inválido: %d", rec.Code)
	}
}
