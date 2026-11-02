package auth

import (
	"testing"
	"time"
)

func TestStoreLifecycle(t *testing.T) {
	now := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	s := NewStore(time.Hour)
	s.now = func() time.Time { return now }

	sess := s.Create(User{Username: "ana"}, "tok")
	if len(sess.ID) < 40 {
		t.Fatalf("ID de sessão curto demais: %q", sess.ID)
	}
	if got, ok := s.Get(sess.ID); !ok || got.User.Username != "ana" || got.Token != "tok" {
		t.Fatalf("Get = %+v, %v", got, ok)
	}

	now = now.Add(61 * time.Minute)
	if _, ok := s.Get(sess.ID); ok {
		t.Error("sessão expirada ainda válida")
	}

	sess = s.Create(User{Username: "bia"}, "")
	s.Delete(sess.ID)
	if _, ok := s.Get(sess.ID); ok {
		t.Error("sessão encerrada ainda válida")
	}
}

func TestStorePurgesExpired(t *testing.T) {
	now := time.Now()
	s := NewStore(time.Minute)
	s.now = func() time.Time { return now }
	s.Create(User{}, "")
	now = now.Add(2 * time.Minute)
	s.Create(User{}, "")
	if n := len(s.sessions); n != 1 {
		t.Errorf("sessões em memória = %d, esperava 1 após limpeza", n)
	}
}

func TestRandomTokenAndEqual(t *testing.T) {
	a, b := RandomToken(), RandomToken()
	if a == b {
		t.Error("tokens repetidos")
	}
	if !Equal(a, a) || Equal(a, b) || Equal(a, "") {
		t.Error("Equal incorreto")
	}
}
