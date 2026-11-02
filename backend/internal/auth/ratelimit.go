package auth

import (
	"sync"
	"time"
)

// LoginLimiter limita tentativas de senha erradas por origem (IP) e por nome
// de usuário, para dificultar ataques de força bruta. Depois de Max falhas
// dentro de Window, novas tentativas são recusadas até a janela passar.
type LoginLimiter struct {
	Max    int
	Window time.Duration
	now    func() time.Time

	mu       sync.Mutex
	failures map[string][]time.Time
}

// NewLoginLimiter cria um limitador com o limite e a janela informados.
func NewLoginLimiter(maxFailures int, window time.Duration) *LoginLimiter {
	return &LoginLimiter{Max: maxFailures, Window: window, now: time.Now, failures: map[string][]time.Time{}}
}

func (l *LoginLimiter) recent(key string) []time.Time {
	cutoff := l.now().Add(-l.Window)
	kept := l.failures[key][:0]
	for _, t := range l.failures[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.failures, key)
		return nil
	}
	l.failures[key] = kept
	return kept
}

// Blocked informa se alguma das chaves atingiu o limite e por quanto tempo.
func (l *LoginLimiter) Blocked(keys ...string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var wait time.Duration
	for _, k := range keys {
		if f := l.recent(k); len(f) >= l.Max {
			if w := f[0].Add(l.Window).Sub(l.now()); w > wait {
				wait = w
			}
		}
	}
	return wait > 0, wait
}

// Fail registra uma tentativa errada para cada chave.
func (l *LoginLimiter) Fail(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		l.failures[k] = append(l.recent(k), l.now())
	}
}

// Reset limpa as falhas das chaves (após um login bem-sucedido).
func (l *LoginLimiter) Reset(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		delete(l.failures, k)
	}
}
