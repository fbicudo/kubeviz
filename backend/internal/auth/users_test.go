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
	if strings.Contains(string(content), "senha-muito-longa-1") || !strings.Contains(string(content), "ana:$2") {
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
