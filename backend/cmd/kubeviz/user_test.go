package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
)

func TestUserCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users")
	run := func(stdin string, args ...string) (int, string) {
		var out, errb bytes.Buffer
		code := runUser(append(args, "--users-file", path), strings.NewReader(stdin), &out, &errb)
		return code, out.String() + errb.String()
	}

	if code, out := run("", "list"); code != 0 || !strings.Contains(out, "Nenhuma conta") {
		t.Fatalf("list vazio: %d %q", code, out)
	}
	if code, out := run("curta\n", "add", "fabio"); code != 1 || !strings.Contains(out, "pelo menos") {
		t.Fatalf("senha curta: %d %q", code, out)
	}
	if code, out := run("senha-de-teste-longa\n", "add", "Fabio"); code != 0 {
		t.Fatalf("add: %d %q", code, out)
	}
	if !auth.NewUsers(path).Verify("fabio", "senha-de-teste-longa") {
		t.Fatal("conta criada pelo comando não confere")
	}
	if code, out := run("", "list"); code != 0 || strings.TrimSpace(out) != "fabio" {
		t.Fatalf("list: %d %q", code, out)
	}
	if code, _ := run("", "remove", "fabio"); code != 0 {
		t.Fatal("remove falhou")
	}
	if code, _ := run("", "remove", "fabio"); code != 1 {
		t.Fatal("remover inexistente deveria falhar")
	}
	if code, _ := run("", "explodir"); code != 2 {
		t.Fatal("subcomando inválido deveria mostrar o uso")
	}
}
