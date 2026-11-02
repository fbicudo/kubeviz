// Package auth cuida das sessões dos usuários da console.
//
// O KubeViz não tem usuários próprios: quem decide o que cada pessoa pode
// fazer é o RBAC do cluster. As sessões apenas guardam, no servidor, a
// credencial com que cada navegador fala com a API do Kubernetes.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"

	authnv1 "k8s.io/api/authentication/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// ErrInvalidCredentials indica um token recusado pela API do Kubernetes.
var ErrInvalidCredentials = errors.New("token inválido ou expirado")

// User é a identidade reconhecida pelo cluster.
type User struct {
	Username string   `json:"username"`
	Groups   []string `json:"groups,omitempty"`
}

// Session é uma sessão autenticada. Token fica vazio no modo local, em que
// as credenciais vêm do kubeconfig.
type Session struct {
	ID      string
	User    User
	Token   string
	Expires time.Time
	// LocalUser é a conta local (usuário e senha) que abriu a sessão, se houver.
	LocalUser string
	// OIDC guarda os tokens do provedor nas sessões abertas por login OIDC.
	OIDC *OIDCTokens
}

// Store guarda sessões em memória. Reiniciar o KubeViz encerra todas as
// sessões; múltiplas réplicas exigirão um armazenamento compartilhado.
type Store struct {
	ttl time.Duration
	now func() time.Time

	mu       sync.Mutex
	sessions map[string]*Session
}

// NewStore cria um armazenamento cujas sessões expiram após ttl.
func NewStore(ttl time.Duration) *Store {
	return &Store{ttl: ttl, now: time.Now, sessions: map[string]*Session{}}
}

// Create abre uma sessão nova com ID aleatório.
func (s *Store) Create(user User, token string) *Session {
	return s.CreateFunc(user, token, nil)
}

// CreateFunc é Create com ajustes feitos antes de a sessão ficar visível.
func (s *Store) CreateFunc(user User, token string, init func(*Session)) *Session {
	sess := &Session{ID: RandomToken(), User: user, Token: token, Expires: s.now().Add(s.ttl)}
	if init != nil {
		init(sess)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeLocked()
	s.sessions[sess.ID] = sess
	return sess
}

// Get devolve a sessão se ela existir e não tiver expirado.
func (s *Store) Get(id string) (*Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return nil, false
	}
	if s.now().After(sess.Expires) {
		delete(s.sessions, id)
		return nil, false
	}
	return sess, true
}

// Delete encerra a sessão.
func (s *Store) Delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, id)
}

// TTL é a duração das sessões.
func (s *Store) TTL() time.Duration { return s.ttl }

func (s *Store) purgeLocked() {
	now := s.now()
	for id, sess := range s.sessions {
		if now.After(sess.Expires) {
			delete(s.sessions, id)
		}
	}
}

// RandomToken gera 32 bytes aleatórios em base64 sem padding (seguro em URLs).
func RandomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand falhou: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Equal compara segredos em tempo constante.
func Equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// WhoAmI pergunta à API quem é o dono das credenciais de cfg
// (SelfSubjectReview). Devolve ErrInvalidCredentials se forem recusadas.
func WhoAmI(ctx context.Context, cfg *rest.Config) (User, error) {
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return User{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	review, err := cs.AuthenticationV1().SelfSubjectReviews().Create(ctx, &authnv1.SelfSubjectReview{}, metav1.CreateOptions{})
	if apierrors.IsUnauthorized(err) {
		return User{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, fmt.Errorf("consultando identidade: %w", err)
	}
	info := review.Status.UserInfo
	return User{Username: info.Username, Groups: info.Groups}, nil
}
