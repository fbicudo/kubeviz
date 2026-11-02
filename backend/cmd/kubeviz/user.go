package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/config"
)

const userUsage = `Gerencia as contas de login do modo local (usuário e senha).

Uso:
  kubeviz user add <nome>      cria a conta ou troca a senha (pede a senha)
  kubeviz user remove <nome>   remove a conta
  kubeviz user list            lista as contas

Opções:
  --users-file <caminho>       arquivo de contas (padrão: %s)

Com ao menos uma conta, a tela de login pede usuário e senha e o link com
token deixa de valer. As mudanças valem na hora, sem reiniciar o KubeViz.
Para informar a senha sem terminal (scripts): echo "$SENHA" | kubeviz user add <nome>
`

// runUser executa "kubeviz user ..." e devolve o código de saída.
func runUser(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("kubeviz user", flag.ContinueOnError)
	fs.SetOutput(stderr)
	path := fs.String("users-file", config.DefaultUsersFile(), "arquivo de contas")
	fs.Usage = func() { fmt.Fprintf(stderr, userUsage, config.DefaultUsersFile()) }

	// Aceita a opção antes ou depois do subcomando.
	var rest []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--users-file" && i+1 < len(args) {
			*path = args[i+1]
			i++
			continue
		}
		if v, ok := strings.CutPrefix(args[i], "--users-file="); ok {
			*path = v
			continue
		}
		if args[i] == "-h" || args[i] == "--help" {
			fs.Usage()
			return 0
		}
		rest = append(rest, args[i])
	}
	if len(rest) == 0 {
		fs.Usage()
		return 2
	}

	fail := func(err error) int {
		fmt.Fprintln(stderr, "erro:", err)
		return 1
	}

	switch {
	case rest[0] == "list" && len(rest) == 1:
		names, err := auth.ListUsers(*path)
		if err != nil {
			return fail(err)
		}
		if len(names) == 0 {
			fmt.Fprintf(stdout, "Nenhuma conta em %s (login pelo link com token).\n", *path)
		}
		for _, n := range names {
			fmt.Fprintln(stdout, n)
		}
		return 0

	case rest[0] == "add" && len(rest) == 2:
		name := strings.ToLower(rest[1])
		password, err := readPassword(stdin, stderr)
		if err != nil {
			return fail(err)
		}
		if err := auth.SetUser(*path, name, password); err != nil {
			return fail(err)
		}
		fmt.Fprintf(stdout, "Conta %q salva em %s.\n", name, *path)
		return 0

	case rest[0] == "remove" && len(rest) == 2:
		if err := auth.RemoveUser(*path, strings.ToLower(rest[1])); err != nil {
			return fail(err)
		}
		fmt.Fprintf(stdout, "Conta %q removida.\n", rest[1])
		return 0
	}
	fs.Usage()
	return 2
}

// readPassword pede a senha duas vezes, sem eco, quando há terminal; sem
// terminal, lê uma linha da entrada padrão.
func readPassword(stdin io.Reader, stderr io.Writer) (string, error) {
	if f, ok := stdin.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		fmt.Fprintf(stderr, "Senha (mínimo %d caracteres): ", auth.MinPasswordLength)
		first, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(stderr)
		if err != nil {
			return "", err
		}
		fmt.Fprint(stderr, "Repita a senha: ")
		second, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(stderr)
		if err != nil {
			return "", err
		}
		if string(first) != string(second) {
			return "", errors.New("as senhas não conferem")
		}
		return string(first), nil
	}
	line, err := bufio.NewReader(stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}
