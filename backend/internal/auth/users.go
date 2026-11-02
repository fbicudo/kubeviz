package auth

// Contas locais (usuário e senha) para o modo local.
//
// No modo local, o KubeViz age com o kubeconfig de quem o executa; as contas
// apenas controlam quem pode abrir a console. Ficam num arquivo no formato
// do htpasswd com bcrypt ("nome:$2a$12$..."), uma por linha, permissão 0600.

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	// MinPasswordLength é o tamanho mínimo de senha aceito por AddUser.
	MinPasswordLength = 12
	bcryptCost        = 12
)

var (
	validUsername = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)

	ErrInvalidUsername = errors.New("nome de usuário inválido: use até 32 letras minúsculas, números, ponto, hífen ou sublinhado")
	ErrShortPassword   = fmt.Errorf("a senha precisa ter pelo menos %d caracteres", MinPasswordLength)
	ErrUserNotFound    = errors.New("usuário não encontrado")
)

// dummyHash é comparado quando o usuário não existe, para que a resposta leve
// o mesmo tempo e não revele quais nomes existem.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("kubeviz-usuario-inexistente"), bcryptCost)

// Users lê o arquivo de contas e o relê quando ele muda, para que contas
// criadas ou removidas valham sem reiniciar o KubeViz.
type Users struct {
	path string

	mu      sync.Mutex
	modTime time.Time
	size    int64
	hashes  map[string][]byte
}

// NewUsers prepara a leitura de path; o arquivo pode ainda não existir.
func NewUsers(path string) *Users {
	return &Users{path: path, hashes: map[string][]byte{}}
}

// Path é o caminho do arquivo de contas.
func (u *Users) Path() string { return u.path }

// refresh relê o arquivo se ele mudou. Chamado com u.mu travado.
func (u *Users) refresh() {
	info, err := os.Stat(u.path)
	if err != nil {
		u.hashes, u.modTime, u.size = map[string][]byte{}, time.Time{}, 0
		return
	}
	if info.ModTime().Equal(u.modTime) && info.Size() == u.size {
		return
	}
	if hashes, err := readUsers(u.path); err == nil {
		u.hashes, u.modTime, u.size = hashes, info.ModTime(), info.Size()
	}
}

// Enabled indica se há ao menos uma conta (e, portanto, login por senha).
func (u *Users) Enabled() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.refresh()
	return len(u.hashes) > 0
}

// Verify confere usuário e senha em tempo aproximadamente constante.
func (u *Users) Verify(name, password string) bool {
	u.mu.Lock()
	u.refresh()
	hash, ok := u.hashes[name]
	u.mu.Unlock()
	if !ok {
		hash = dummyHash
	}
	return bcrypt.CompareHashAndPassword(hash, []byte(password)) == nil && ok
}

func readUsers(path string) (map[string][]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := map[string][]byte{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, hash, found := strings.Cut(line, ":")
		if found && validUsername.MatchString(name) && strings.HasPrefix(hash, "$2") {
			out[name] = []byte(hash)
		}
	}
	return out, sc.Err()
}

func writeUsers(path string, hashes map[string][]byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	names := make([]string, 0, len(hashes))
	for n := range hashes {
		names = append(names, n)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString("# Contas do KubeViz (modo local). Gerencie com: kubeviz user add|remove|list\n")
	for _, n := range names {
		fmt.Fprintf(&b, "%s:%s\n", n, hashes[n])
	}
	// Escrita atômica: arquivo temporário no mesmo diretório + rename.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".users-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(b.String()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func loadForEdit(path string) (map[string][]byte, error) {
	hashes, err := readUsers(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string][]byte{}, nil
	}
	return hashes, err
}

// SetUser cria a conta ou troca a senha de uma existente.
func SetUser(path, name, password string) error {
	if !validUsername.MatchString(name) {
		return ErrInvalidUsername
	}
	if len([]rune(password)) < MinPasswordLength {
		return ErrShortPassword
	}
	hashes, err := loadForEdit(path)
	if err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return err
	}
	hashes[name] = hash
	return writeUsers(path, hashes)
}

// RemoveUser apaga uma conta.
func RemoveUser(path, name string) error {
	hashes, err := loadForEdit(path)
	if err != nil {
		return err
	}
	if _, ok := hashes[name]; !ok {
		return ErrUserNotFound
	}
	delete(hashes, name)
	return writeUsers(path, hashes)
}

// ListUsers devolve os nomes das contas em ordem alfabética.
func ListUsers(path string) ([]string, error) {
	hashes, err := loadForEdit(path)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(hashes))
	for n := range hashes {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, nil
}
