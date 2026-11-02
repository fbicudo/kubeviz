package server

import (
	"crypto/tls"
	"fmt"
	"os"
	"sync"
	"time"
)

// certReloader carrega o par certificado/chave e o recarrega quando os
// arquivos mudam, para que certificados renovados (cert-manager, Secret
// atualizado) passem a valer sem reiniciar o pod.
type certReloader struct {
	certFile, keyFile string

	mu      sync.Mutex
	cert    *tls.Certificate
	modTime time.Time
	checked time.Time
}

func newCertReloader(certFile, keyFile string) (*certReloader, error) {
	r := &certReloader{certFile: certFile, keyFile: keyFile}
	if err := r.load(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *certReloader) load() error {
	info, err := os.Stat(r.certFile)
	if err != nil {
		return fmt.Errorf("certificado TLS: %w", err)
	}
	cert, err := tls.LoadX509KeyPair(r.certFile, r.keyFile)
	if err != nil {
		return fmt.Errorf("certificado TLS: %w", err)
	}
	r.cert = &cert
	r.modTime = info.ModTime()
	return nil
}

// GetCertificate verifica no máximo a cada 30 s se o arquivo mudou. Se a nova
// versão for inválida, continua servindo a anterior.
func (r *certReloader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if time.Since(r.checked) > 30*time.Second {
		r.checked = time.Now()
		if info, err := os.Stat(r.certFile); err == nil && !info.ModTime().Equal(r.modTime) {
			_ = r.load()
		}
	}
	return r.cert, nil
}

func (s *Server) tlsConfig() (*tls.Config, error) {
	reloader, err := newCertReloader(s.opts.TLSCertFile, s.opts.TLSKeyFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: reloader.GetCertificate,
		NextProtos:     []string{"h2", "http/1.1"},
	}, nil
}
