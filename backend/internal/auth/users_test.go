package auth

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUsersLifecycle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kubeviz", "users")
	u := NewUsers(path)
	if u.Enabled() {
		t.Fatal("sem arquivo, o login por senha não deveria estar ativo")
	}

	if err := SetUser(path, "ana", "senha-muito-longa-1"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("arquivo de contas: %v, permissão %v (quer 0600)", err, info.Mode().Perm())
	}
	content, _ := os.ReadFile(path)
	if strings.Contains(string(content), "senha-muito-longa-1") || !strings.Contains(string(content), `"passwordHash": "$2`) {
		t.Fatalf("o arquivo deve guardar só o hash bcrypt: %q", content)
	}

	// Conta criada com o KubeViz no ar: vale sem reiniciar.
	if !u.Enabled() || !u.Verify("ana", "senha-muito-longa-1") {
		t.Fatal("conta nova não reconhecida")
	}
	if u.Verify("ana", "senha-errada-qualquer") || u.Verify("bia", "senha-muito-longa-1") {
		t.Fatal("senha errada ou usuário inexistente aceitos")
	}

	// Troca de senha.
	if err := SetUser(path, "ana", "outra-senha-bem-longa"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	if u.Verify("ana", "senha-muito-longa-1") || !u.Verify("ana", "outra-senha-bem-longa") {
		t.Fatal("troca de senha não aplicada")
	}

	if names, _ := ListUsers(path); len(names) != 1 || names[0] != "ana" {
		t.Fatalf("ListUsers = %v", names)
	}
	if err := RemoveUser(path, "ana"); err != nil {
		t.Fatal(err)
	}
	if u.Enabled() {
		t.Fatal("sem contas, o login por senha deveria desligar")
	}
	if err := RemoveUser(path, "ana"); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("remover inexistente: %v", err)
	}
}

func TestSetUserValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users")
	cases := map[string]struct {
		name, pass string
		want       error
	}{
		"senha curta":          {"ana", "curta", ErrShortPassword},
		"nome com espaço":      {"ana maria", "senha-muito-longa-1", ErrInvalidUsername},
		"nome maiúsculo":       {"Ana", "senha-muito-longa-1", ErrInvalidUsername},
		"nome com dois-pontos": {"a:b", "senha-muito-longa-1", ErrInvalidUsername},
	}
	for name, c := range cases {
		if err := SetUser(path, c.name, c.pass); !errors.Is(err, c.want) {
			t.Errorf("%s: erro %v, quer %v", name, err, c.want)
		}
	}
}

func TestLoginLimiter(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	l := NewLoginLimiter(3, 5*time.Minute)
	l.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if blocked, _ := l.Blocked("ip:1", "user:ana"); blocked {
			t.Fatalf("bloqueado cedo demais (tentativa %d)", i+1)
		}
		l.Fail("ip:1", "user:ana")
		now = now.Add(time.Second)
	}
	blocked, wait := l.Blocked("ip:2", "user:ana")
	if !blocked || wait <= 0 || wait > 5*time.Minute {
		t.Fatalf("o usuário atacado deveria ficar bloqueado mesmo de outro IP: %v %v", blocked, wait)
	}
	if blocked, _ := l.Blocked("ip:2", "user:bia"); blocked {
		t.Fatal("outro usuário e outro IP não deveriam ser afetados")
	}

	now = now.Add(5 * time.Minute)
	if blocked, _ := l.Blocked("ip:1", "user:ana"); blocked {
		t.Fatal("a janela passou; deveria liberar")
	}

	l.Fail("ip:1")
	l.Reset("ip:1")
	if f := l.recent("ip:1"); len(f) != 0 {
		t.Fatal("Reset não limpou as falhas")
	}
}

func TestAddUserRefusesExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users")
	if err := AddUser(path, "ana", "senha-de-teste-com-tamanho"); err != nil {
		t.Fatal(err)
	}
	if err := AddUser(path, "ana", "outra-senha-de-teste-longa"); !errors.Is(err, ErrUserExists) {
		t.Fatalf("conta repetida: %v", err)
	}
	if !NewUsers(path).Verify("ana", "senha-de-teste-com-tamanho") {
		t.Error("a senha original foi trocada")
	}
}

func TestLegacyFileStillWorks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users")
	hash, _ := hashPassword("senha-de-teste-com-tamanho")
	legacy := "# Contas do KubeViz (modo local)\nfabio:" + hash + "\n"
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	u := NewUsers(path)
	acc, ok := u.Get("fabio")
	if !ok || !acc.Admin || !u.Verify("fabio", "senha-de-teste-com-tamanho") {
		t.Fatalf("conta do formato antigo: %+v", acc)
	}
	// A primeira alteração grava no formato novo, sem perder a conta.
	if err := u.Create(Account{Name: "bia", Emails: []string{"Bia@Exemplo.com"}}, ""); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(content), "{") || !u.Verify("fabio", "senha-de-teste-com-tamanho") {
		t.Fatalf("migração: %s", content)
	}
}

func TestAccountsEmailsAndAdmins(t *testing.T) {
	u := NewUsers(filepath.Join(t.TempDir(), "users"))
	if err := u.Create(Account{Name: "admin", Admin: true}, "senha-de-teste-com-tamanho"); err != nil {
		t.Fatal(err)
	}
	// Só e-mail (entra por provedor); e-mail normalizado.
	if err := u.Create(Account{Name: "bia", Emails: []string{" Bia@Exemplo.com "}}, ""); err != nil {
		t.Fatal(err)
	}
	if acc, created, err := u.ForEmail("bia@exemplo.com"); err != nil || created || acc.Name != "bia" {
		t.Fatalf("ForEmail: %+v %v %v", acc, created, err)
	}
	// Sem senha nem e-mail não serve; e-mail de outra conta também não.
	if err := u.Create(Account{Name: "vazio"}, ""); !errors.Is(err, ErrNoLoginMethod) {
		t.Errorf("sem método: %v", err)
	}
	if err := u.Create(Account{Name: "copia", Emails: []string{"bia@exemplo.com"}}, ""); !errors.Is(err, ErrEmailInUse) {
		t.Errorf("e-mail repetido: %v", err)
	}
	if err := u.Create(Account{Name: "x", Emails: []string{"nao-e-email"}}, ""); !errors.Is(err, ErrInvalidEmail) {
		t.Errorf("e-mail inválido: %v", err)
	}
	// Senha só por provedor: Verify nunca aceita conta sem senha.
	if u.Verify("bia", "") {
		t.Error("conta sem senha aceitou senha vazia")
	}

	// E-mail desconhecido: recusado, a não ser que o domínio esteja liberado.
	if _, _, err := u.ForEmail("carla.souza@empresa.com"); !errors.Is(err, ErrUserNotFound) {
		t.Errorf("e-mail desconhecido: %v", err)
	}
	if err := u.SetAllowedDomains([]string{"@Empresa.com", "", "empresa.com"}); err != nil {
		t.Fatal(err)
	}
	if err := u.SetAllowedDomains([]string{"sem ponto"}); !errors.Is(err, ErrInvalidDomain) {
		t.Errorf("domínio inválido: %v", err)
	}
	acc, created, err := u.ForEmail("carla.souza@empresa.com")
	if err != nil || !created || acc.Name != "carla.souza" || acc.Admin {
		t.Fatalf("conta criada pelo domínio: %+v %v %v", acc, created, err)
	}
	if acc, created, _ := u.ForEmail("carla.souza@empresa.com"); created || acc.Name != "carla.souza" {
		t.Errorf("segundo acesso não deve criar outra conta: %+v", acc)
	}
	if _, _, err := u.ForEmail("intruso@empresa.com.evil.io"); !errors.Is(err, ErrUserNotFound) {
		t.Errorf("subdomínio de outro domínio aceito: %v", err)
	}

	// Sempre sobra um administrador.
	no := false
	if err := u.Update("admin", AccountChanges{Admin: &no}); !errors.Is(err, ErrLastAdmin) {
		t.Errorf("rebaixar o último admin: %v", err)
	}
	if err := u.Remove("admin"); !errors.Is(err, ErrLastAdmin) {
		t.Errorf("remover o último admin: %v", err)
	}
	yes := true
	if err := u.Update("bia", AccountChanges{Admin: &yes}); err != nil {
		t.Fatal(err)
	}
	if err := u.Remove("admin"); err != nil {
		t.Errorf("com outro admin, remover deveria funcionar: %v", err)
	}
	// Tirar a senha de quem não tem e-mail deixaria a conta sem acesso.
	if err := u.Create(Account{Name: "so-senha"}, "senha-de-teste-com-tamanho"); err != nil {
		t.Fatal(err)
	}
	if err := u.Update("so-senha", AccountChanges{RemovePassword: true}); !errors.Is(err, ErrNoLoginMethod) {
		t.Errorf("remover a única forma de entrar: %v", err)
	}
}
