package auth

// Contas locais para o modo local.
//
// No modo local, o KubeViz age com o kubeconfig de quem o executa; as contas
// controlam quem pode abrir a console. Cada conta entra com senha (bcrypt),
// com um e-mail verificado por um provedor (Google, Microsoft, GitHub, OIDC),
// ou com os dois. Administradores gerenciam as contas e os provedores.
//
// Tudo fica num arquivo JSON com permissão 0600, relido quando muda (o
// comando `kubeviz user` e a página de usuários valem sem reiniciar). Arquivos
// do formato antigo ("nome:hash" por linha) continuam sendo lidos; as contas
// deles viram administradoras.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	// MinPasswordLength é o tamanho mínimo de senha.
	MinPasswordLength = 12
	bcryptCost        = 12
)

var (
	validUsername = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)
	validEmail    = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	validDomain   = regexp.MustCompile(`^([a-z0-9-]+\.)+[a-z]{2,}$`)

	ErrInvalidUsername = errors.New("nome de usuário inválido: use até 32 letras minúsculas, números, ponto, hífen ou sublinhado")
	ErrShortPassword   = fmt.Errorf("a senha precisa ter pelo menos %d caracteres", MinPasswordLength)
	ErrUserNotFound    = errors.New("usuário não encontrado")
	ErrUserExists      = errors.New("já existe uma conta com esse nome")
	ErrInvalidEmail    = errors.New("e-mail inválido")
	ErrEmailInUse      = errors.New("esse e-mail já está em outra conta")
	ErrNoLoginMethod   = errors.New("a conta precisa de uma senha ou de um e-mail para entrar por um provedor")
	ErrLastAdmin       = errors.New("é preciso manter ao menos um administrador")
	ErrInvalidDomain   = errors.New("domínio inválido (ex.: empresa.com)")
)

// dummyHash é comparado quando o usuário não existe, para que a resposta leve
// o mesmo tempo e não revele quais nomes existem.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("kubeviz-usuario-inexistente"), bcryptCost)

// Account é uma conta local.
type Account struct {
	Name string `json:"name"`
	// PasswordHash vazio: a conta só entra por provedor.
	PasswordHash string `json:"passwordHash,omitempty"`
	Admin        bool   `json:"admin"`
	// Emails com que a conta entra pelos provedores de identidade.
	Emails  []string  `json:"emails,omitempty"`
	Created time.Time `json:"created,omitzero"`
}

// HasPassword indica se a conta entra com senha.
func (a Account) HasPassword() bool { return a.PasswordHash != "" }

// Data é o conteúdo do arquivo de contas.
type Data struct {
	Version  int       `json:"version"`
	Accounts []Account `json:"accounts"`
	// AllowedDomains: quem entra por um provedor com e-mail destes domínios
	// ganha uma conta (sem ser administrador) no primeiro acesso.
	AllowedDomains []string `json:"allowedDomains,omitempty"`
	// Providers são os provedores de identidade configurados pela interface.
	Providers []ProviderConfig `json:"providers,omitempty"`
}

// ProviderConfig é um provedor de identidade configurado por um administrador.
type ProviderConfig struct {
	// ID identifica o provedor na URL (google, microsoft, github, ou um nome).
	ID string `json:"id"`
	// Type: google, microsoft, github ou oidc.
	Type         string `json:"type"`
	Name         string `json:"name,omitempty"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	// IssuerURL: só para o tipo oidc.
	IssuerURL string `json:"issuerUrl,omitempty"`
	// Tenant: só para o tipo microsoft (padrão "common": contas pessoais e de organizações).
	Tenant string `json:"tenant,omitempty"`
}

func (d *Data) find(name string) int {
	return slices.IndexFunc(d.Accounts, func(a Account) bool { return a.Name == name })
}

func (d *Data) admins() int {
	n := 0
	for _, a := range d.Accounts {
		if a.Admin {
			n++
		}
	}
	return n
}

// Users lê o arquivo de contas e o relê quando ele muda.
type Users struct {
	path string

	mu      sync.Mutex
	modTime time.Time
	size    int64
	data    Data
}

// NewUsers prepara a leitura de path; o arquivo pode ainda não existir.
func NewUsers(path string) *Users {
	return &Users{path: path}
}

// Path é o caminho do arquivo de contas.
func (u *Users) Path() string { return u.path }

// refresh relê o arquivo se ele mudou. Chamado com u.mu travado.
func (u *Users) refresh() {
	info, err := os.Stat(u.path)
	if err != nil {
		u.data, u.modTime, u.size = Data{}, time.Time{}, 0
		return
	}
	if info.ModTime().Equal(u.modTime) && info.Size() == u.size {
		return
	}
	if data, err := readData(u.path); err == nil {
		u.data, u.modTime, u.size = data, info.ModTime(), info.Size()
	}
}

// Snapshot devolve uma cópia dos dados atuais.
func (u *Users) Snapshot() Data {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.refresh()
	d := u.data
	d.Accounts = slices.Clone(d.Accounts)
	d.AllowedDomains = slices.Clone(d.AllowedDomains)
	d.Providers = slices.Clone(d.Providers)
	return d
}

// Enabled indica se há ao menos uma conta.
func (u *Users) Enabled() bool { return len(u.Snapshot().Accounts) > 0 }

// Get devolve a conta pelo nome.
func (u *Users) Get(name string) (Account, bool) {
	d := u.Snapshot()
	if i := d.find(name); i >= 0 {
		return d.Accounts[i], true
	}
	return Account{}, false
}

// Verify confere usuário e senha em tempo aproximadamente constante.
func (u *Users) Verify(name, password string) bool {
	acc, ok := u.Get(name)
	hash := []byte(acc.PasswordHash)
	if !ok || len(hash) == 0 {
		hash = dummyHash
	}
	return bcrypt.CompareHashAndPassword(hash, []byte(password)) == nil && ok && acc.HasPassword()
}

// ForEmail devolve a conta que entra com o e-mail (já verificado pelo
// provedor). Sem conta, mas com o domínio liberado, devolve created=true e o
// nome sugerido para a conta nova, que é criada aqui.
func (u *Users) ForEmail(email string) (acc Account, created bool, err error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !validEmail.MatchString(email) {
		return Account{}, false, ErrInvalidEmail
	}
	d := u.Snapshot()
	for _, a := range d.Accounts {
		if slices.Contains(a.Emails, email) {
			return a, false, nil
		}
	}
	domain := email[strings.LastIndex(email, "@")+1:]
	if !slices.Contains(d.AllowedDomains, domain) {
		return Account{}, false, ErrUserNotFound
	}
	acc = Account{Name: nameFromEmail(email, d), Emails: []string{email}}
	if err := u.Create(acc, ""); err != nil {
		return Account{}, false, err
	}
	acc, _ = u.Get(acc.Name)
	return acc, true, nil
}

// nameFromEmail sugere um nome livre a partir do e-mail (ana.silva@x → ana.silva).
func nameFromEmail(email string, d Data) string {
	base := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, strings.ToLower(email[:strings.Index(email, "@")]))
	base = strings.TrimLeft(base, ".-_")
	if len(base) > 28 {
		base = base[:28]
	}
	if base == "" {
		base = "usuario"
	}
	name := base
	for i := 2; d.find(name) >= 0; i++ {
		name = fmt.Sprintf("%s-%d", base, i)
	}
	return name
}

// Create cria uma conta nova. password vazio: a conta só entra por provedor
// (precisa de ao menos um e-mail).
func (u *Users) Create(acc Account, password string) error {
	if !validUsername.MatchString(acc.Name) {
		return ErrInvalidUsername
	}
	emails, err := cleanEmails(acc.Emails)
	if err != nil {
		return err
	}
	acc.Emails = emails
	if password == "" && len(acc.Emails) == 0 {
		return ErrNoLoginMethod
	}
	if password != "" {
		if acc.PasswordHash, err = hashPassword(password); err != nil {
			return err
		}
	}
	acc.Created = time.Now().UTC().Truncate(time.Second)
	return u.edit(func(d *Data) error {
		if d.find(acc.Name) >= 0 {
			return ErrUserExists
		}
		if err := emailsFree(d, acc.Name, acc.Emails); err != nil {
			return err
		}
		d.Accounts = append(d.Accounts, acc)
		return nil
	})
}

// AccountChanges são as alterações de uma conta; nil = mantém.
type AccountChanges struct {
	Password *string
	// RemovePassword: a conta passa a entrar só por provedor.
	RemovePassword bool
	Admin          *bool
	Emails         *[]string
}

// Update altera uma conta.
func (u *Users) Update(name string, c AccountChanges) error {
	var hash string
	if c.Password != nil {
		var err error
		if hash, err = hashPassword(*c.Password); err != nil {
			return err
		}
	}
	var emails []string
	if c.Emails != nil {
		var err error
		if emails, err = cleanEmails(*c.Emails); err != nil {
			return err
		}
	}
	return u.edit(func(d *Data) error {
		i := d.find(name)
		if i < 0 {
			return ErrUserNotFound
		}
		acc := d.Accounts[i]
		if c.Password != nil {
			acc.PasswordHash = hash
		} else if c.RemovePassword {
			acc.PasswordHash = ""
		}
		if c.Emails != nil {
			if err := emailsFree(d, name, emails); err != nil {
				return err
			}
			acc.Emails = emails
		}
		if c.Admin != nil {
			if acc.Admin && !*c.Admin && d.admins() == 1 {
				return ErrLastAdmin
			}
			acc.Admin = *c.Admin
		}
		if !acc.HasPassword() && len(acc.Emails) == 0 {
			return ErrNoLoginMethod
		}
		d.Accounts[i] = acc
		return nil
	})
}

// Remove apaga uma conta; o último administrador não pode ser removido.
func (u *Users) Remove(name string) error {
	return u.edit(func(d *Data) error {
		i := d.find(name)
		if i < 0 {
			return ErrUserNotFound
		}
		if d.Accounts[i].Admin && d.admins() == 1 && len(d.Accounts) > 1 {
			return ErrLastAdmin
		}
		d.Accounts = slices.Delete(d.Accounts, i, i+1)
		return nil
	})
}

// SetAllowedDomains define os domínios cujos e-mails criam a própria conta.
func (u *Users) SetAllowedDomains(domains []string) error {
	var clean []string
	for _, dom := range domains {
		dom = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(dom), "@"))
		if dom == "" {
			continue
		}
		if !validDomain.MatchString(dom) {
			return fmt.Errorf("%w: %s", ErrInvalidDomain, dom)
		}
		if !slices.Contains(clean, dom) {
			clean = append(clean, dom)
		}
	}
	return u.edit(func(d *Data) error {
		d.AllowedDomains = clean
		return nil
	})
}

// SetProviders grava os provedores de identidade.
func (u *Users) SetProviders(providers []ProviderConfig) error {
	return u.edit(func(d *Data) error {
		d.Providers = providers
		return nil
	})
}

// edit aplica uma alteração ao arquivo, com escrita atômica.
func (u *Users) edit(f func(*Data) error) error {
	editMu.Lock()
	defer editMu.Unlock()
	d, err := readData(u.path)
	if errors.Is(err, os.ErrNotExist) {
		d, err = Data{}, nil
	}
	if err != nil {
		return err
	}
	if err := f(&d); err != nil {
		return err
	}
	if err := writeData(u.path, d); err != nil {
		return err
	}
	u.mu.Lock()
	u.modTime = time.Time{} // força a releitura
	u.mu.Unlock()
	return nil
}

// editMu serializa as alterações do arquivo feitas por este processo.
var editMu sync.Mutex

func hashPassword(password string) (string, error) {
	if len([]rune(password)) < MinPasswordLength {
		return "", ErrShortPassword
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	return string(hash), err
}

func cleanEmails(emails []string) ([]string, error) {
	var out []string
	for _, e := range emails {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" {
			continue
		}
		if !validEmail.MatchString(e) {
			return nil, fmt.Errorf("%w: %s", ErrInvalidEmail, e)
		}
		if !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	return out, nil
}

// emailsFree confere que nenhum dos e-mails é de outra conta.
func emailsFree(d *Data, owner string, emails []string) error {
	for _, a := range d.Accounts {
		if a.Name == owner {
			continue
		}
		for _, e := range emails {
			if slices.Contains(a.Emails, e) {
				return fmt.Errorf("%w (%s)", ErrEmailInUse, a.Name)
			}
		}
	}
	return nil
}

func readData(path string) (Data, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Data{}, err
	}
	if trimmed := bytes.TrimSpace(b); len(trimmed) > 0 && trimmed[0] == '{' {
		var d Data
		if err := json.Unmarshal(trimmed, &d); err != nil {
			return Data{}, fmt.Errorf("lendo %s: %w", path, err)
		}
		return d, nil
	}
	return readLegacy(b)
}

// readLegacy lê o formato antigo ("nome:hash" por linha); as contas viram
// administradoras, pois foram criadas por quem tinha acesso ao terminal.
func readLegacy(b []byte) (Data, error) {
	var d Data
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, hash, found := strings.Cut(line, ":")
		if found && validUsername.MatchString(name) && strings.HasPrefix(hash, "$2") {
			d.Accounts = append(d.Accounts, Account{Name: name, PasswordHash: hash, Admin: true})
		}
	}
	return d, sc.Err()
}

func writeData(path string, d Data) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	d.Version = 2
	sort.Slice(d.Accounts, func(i, j int) bool { return d.Accounts[i].Name < d.Accounts[j].Name })
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
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
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// SetUser (comando `kubeviz user add`) cria a conta como administradora ou
// troca a senha de uma existente.
func SetUser(path, name, password string) error {
	u := NewUsers(path)
	if _, ok := u.Get(name); ok {
		return u.Update(name, AccountChanges{Password: &password})
	}
	return u.Create(Account{Name: name, Admin: true}, password)
}

// AddUser cria uma conta nova com senha; recusa nomes já usados.
func AddUser(path, name, password string) error {
	return NewUsers(path).Create(Account{Name: name}, password)
}

// RemoveUser apaga uma conta.
func RemoveUser(path, name string) error { return NewUsers(path).Remove(name) }

// ListUsers devolve os nomes das contas em ordem alfabética.
func ListUsers(path string) ([]string, error) {
	d, err := readData(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(d.Accounts))
	for _, a := range d.Accounts {
		names = append(names, a.Name)
	}
	sort.Strings(names)
	return names, nil
}
