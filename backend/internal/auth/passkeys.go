package auth

// Passkeys (WebAuthn) das contas locais: entrar com a digital, o rosto ou o
// PIN do dispositivo, sem senha. As passkeys são residentes, então a pessoa
// nem precisa digitar o usuário. Ficam no arquivo de contas, junto da conta.

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// MaxPasskeys por conta.
const MaxPasskeys = 20

var (
	ErrPasskeyNotFound = errors.New("passkey não encontrada")
	ErrPasskeyExists   = errors.New("esta passkey já está cadastrada")
	ErrTooManyPasskeys = fmt.Errorf("limite de %d passkeys por conta", MaxPasskeys)
)

// Passkey é uma credencial WebAuthn de uma conta.
type Passkey struct {
	Name       string              `json:"name"`
	Created    time.Time           `json:"created"`
	LastUsed   time.Time           `json:"lastUsed,omitzero"`
	Credential webauthn.Credential `json:"credential"`
}

// PasskeyID é o identificador da credencial em base64url (usado na API).
func (p Passkey) PasskeyID() string { return base64.RawURLEncoding.EncodeToString(p.Credential.ID) }

// WebAuthnUser adapta uma conta à interface da biblioteca WebAuthn.
type WebAuthnUser struct{ Account Account }

func (u WebAuthnUser) WebAuthnID() []byte {
	id, _ := base64.RawURLEncoding.DecodeString(u.Account.WebAuthnID)
	return id
}
func (u WebAuthnUser) WebAuthnName() string        { return u.Account.Name }
func (u WebAuthnUser) WebAuthnDisplayName() string { return u.Account.Name }
func (u WebAuthnUser) WebAuthnCredentials() []webauthn.Credential {
	out := make([]webauthn.Credential, 0, len(u.Account.Passkeys))
	for _, p := range u.Account.Passkeys {
		out = append(out, p.Credential)
	}
	return out
}

// WebAuthnUserFor devolve a conta pronta para o WebAuthn, criando o
// identificador WebAuthn dela se ainda não existir.
func (u *Users) WebAuthnUserFor(name string) (WebAuthnUser, error) {
	if acc, ok := u.Get(name); ok && acc.WebAuthnID != "" {
		return WebAuthnUser{acc}, nil
	}
	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		return WebAuthnUser{}, err
	}
	err := u.edit(func(d *Data) error {
		i := d.find(name)
		if i < 0 {
			return ErrUserNotFound
		}
		if d.Accounts[i].WebAuthnID == "" {
			d.Accounts[i].WebAuthnID = base64.RawURLEncoding.EncodeToString(id)
		}
		return nil
	})
	if err != nil {
		return WebAuthnUser{}, err
	}
	acc, _ := u.Get(name)
	return WebAuthnUser{acc}, nil
}

// ByWebAuthnID encontra a conta pelo identificador que a passkey devolve.
func (u *Users) ByWebAuthnID(id []byte) (Account, bool) {
	want := base64.RawURLEncoding.EncodeToString(id)
	for _, a := range u.Snapshot().Accounts {
		if a.WebAuthnID != "" && a.WebAuthnID == want {
			return a, true
		}
	}
	return Account{}, false
}

// AddPasskey cadastra uma passkey na conta.
func (u *Users) AddPasskey(name string, p Passkey) error {
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		p.Name = "Passkey"
	}
	if len([]rune(p.Name)) > 64 {
		p.Name = string([]rune(p.Name)[:64])
	}
	return u.edit(func(d *Data) error {
		i := d.find(name)
		if i < 0 {
			return ErrUserNotFound
		}
		acc := &d.Accounts[i]
		if slices.ContainsFunc(acc.Passkeys, func(x Passkey) bool { return x.PasskeyID() == p.PasskeyID() }) {
			return ErrPasskeyExists
		}
		if len(acc.Passkeys) >= MaxPasskeys {
			return ErrTooManyPasskeys
		}
		acc.Passkeys = append(acc.Passkeys, p)
		return nil
	})
}

// RemovePasskey apaga uma passkey da conta.
func (u *Users) RemovePasskey(name, id string) error {
	return u.edit(func(d *Data) error {
		i := d.find(name)
		if i < 0 {
			return ErrUserNotFound
		}
		before := len(d.Accounts[i].Passkeys)
		d.Accounts[i].Passkeys = slices.DeleteFunc(d.Accounts[i].Passkeys, func(p Passkey) bool { return p.PasskeyID() == id })
		if len(d.Accounts[i].Passkeys) == before {
			return ErrPasskeyNotFound
		}
		return nil
	})
}

// PasskeyUsed atualiza a credencial depois de um login (contador de uso,
// flags) e registra quando foi usada.
func (u *Users) PasskeyUsed(name string, cred webauthn.Credential) error {
	id := base64.RawURLEncoding.EncodeToString(cred.ID)
	return u.edit(func(d *Data) error {
		i := d.find(name)
		if i < 0 {
			return ErrUserNotFound
		}
		for j, p := range d.Accounts[i].Passkeys {
			if p.PasskeyID() == id {
				d.Accounts[i].Passkeys[j].Credential = cred
				d.Accounts[i].Passkeys[j].LastUsed = time.Now().UTC().Truncate(time.Second)
				return nil
			}
		}
		return ErrPasskeyNotFound
	})
}
