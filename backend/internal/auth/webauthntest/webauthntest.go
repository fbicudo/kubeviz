// Package webauthntest é um autenticador WebAuthn de software para testes:
// cria passkeys (ES256, atestação "none") e assina desafios de login.
package webauthntest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

// Authenticator guarda as passkeys criadas, como um celular ou chave física.
type Authenticator struct {
	t     *testing.T
	keys  []*passkey // em ordem de criação (Get usa a primeira do RP)
	Count uint32     // contador de uso; os testes podem fazê-lo voltar atrás
}

type passkey struct {
	id         []byte
	key        *ecdsa.PrivateKey
	userHandle []byte
	rpID       string
}

// New cria um autenticador vazio.
func New(t *testing.T) *Authenticator {
	return &Authenticator{t: t}
}

var b64 = base64.RawURLEncoding

// options é o mínimo que o autenticador lê das opções do servidor.
type options struct {
	PublicKey struct {
		Challenge string `json:"challenge"`
		RP        struct {
			ID string `json:"id"`
		} `json:"rp"`
		RPID string `json:"rpId"`
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	} `json:"publicKey"`
}

func (a *Authenticator) parse(raw []byte) options {
	a.t.Helper()
	var o options
	if err := json.Unmarshal(raw, &o); err != nil {
		a.t.Fatalf("opções WebAuthn: %v", err)
	}
	return o
}

func clientData(typ, challenge, origin string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false})
	return b
}

// authData: hash do RP, flags (presença, verificação, backup) e contador.
func authData(rpID string, flags byte, count uint32, attested []byte) []byte {
	h := sha256.Sum256([]byte(rpID))
	out := append(h[:], flags)
	out = binary.BigEndian.AppendUint32(out, count)
	return append(out, attested...)
}

const (
	flagUP = 0x01
	flagUV = 0x04
	flagAT = 0x40
)

// Create responde a navigator.credentials.create: devolve o JSON da credencial.
func (a *Authenticator) Create(optionsJSON []byte, origin string) []byte {
	a.t.Helper()
	o := a.parse(optionsJSON)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	userHandle, err := b64.DecodeString(o.PublicKey.User.ID)
	if err != nil {
		a.t.Fatalf("user.id: %v", err)
	}
	a.keys = append(a.keys, &passkey{id: id, key: key, userHandle: userHandle, rpID: o.PublicKey.RP.ID})

	x, y := key.X.FillBytes(make([]byte, 32)), key.Y.FillBytes(make([]byte, 32))
	cose, _ := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: x, -3: y})
	attested := make([]byte, 16) // AAGUID zerado
	attested = binary.BigEndian.AppendUint16(attested, uint16(len(id)))
	attested = append(append(attested, id...), cose...)
	att, _ := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": authData(o.PublicKey.RP.ID, flagUP|flagUV|flagAT, 0, attested)})

	out, _ := json.Marshal(map[string]any{
		"id": b64.EncodeToString(id), "rawId": b64.EncodeToString(id), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(clientData("webauthn.create", o.PublicKey.Challenge, origin)),
			"attestationObject": b64.EncodeToString(att),
			"transports":        []string{"internal"},
		},
	})
	return out
}

// Get responde a navigator.credentials.get com a primeira passkey do RP.
func (a *Authenticator) Get(optionsJSON []byte, origin string) []byte {
	a.t.Helper()
	o := a.parse(optionsJSON)
	for _, p := range a.keys {
		if p.rpID != o.PublicKey.RPID {
			continue
		}
		a.Count++
		ad := authData(p.rpID, flagUP|flagUV, a.Count, nil)
		cd := clientData("webauthn.get", o.PublicKey.Challenge, origin)
		h := sha256.Sum256(cd)
		// ES256: assina o SHA-256 de authenticatorData || SHA-256(clientDataJSON).
		digest := sha256.Sum256(append(append([]byte{}, ad...), h[:]...))
		sig, err := ecdsa.SignASN1(rand.Reader, p.key, digest[:])
		if err != nil {
			a.t.Fatal(err)
		}
		out, _ := json.Marshal(map[string]any{
			"id": b64.EncodeToString(p.id), "rawId": b64.EncodeToString(p.id), "type": "public-key",
			"response": map[string]any{
				"clientDataJSON":    b64.EncodeToString(cd),
				"authenticatorData": b64.EncodeToString(ad),
				"signature":         b64.EncodeToString(sig),
				"userHandle":        b64.EncodeToString(p.userHandle),
			},
		})
		return out
	}
	a.t.Fatalf("nenhuma passkey para %s", o.PublicKey.RPID)
	return nil
}
