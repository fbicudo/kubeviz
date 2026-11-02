package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeSelfSigned grava um certificado autoassinado para 127.0.0.1.
func writeSelfSigned(t *testing.T, dir, cn string) (certFile, keyFile string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	certFile, keyFile = filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key")
	_ = os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	_ = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600)
	return certFile, keyFile
}

func TestServeTLS(t *testing.T) {
	certFile, keyFile := writeSelfSigned(t, t.TempDir(), "kubeviz-teste")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newServer(newFakeCluster(), Options{LoopbackOnly: true, TLSCertFile: certFile, TLSKeyFile: keyFile})
	go func() { _ = s.Serve(ctx, ln) }()

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	resp, err := client.Get("https://" + ln.Addr().String() + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.TLS == nil {
		t.Fatalf("status %d, TLS %v", resp.StatusCode, resp.TLS != nil)
	}
	if cn := resp.TLS.PeerCertificates[0].Subject.CommonName; cn != "kubeviz-teste" {
		t.Errorf("certificado servido: %q", cn)
	}
	if resp.Header.Get("Strict-Transport-Security") == "" {
		t.Error("HSTS ausente em HTTPS")
	}
}

func TestServeTLSInvalidCert(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	s := newServer(newFakeCluster(), Options{TLSCertFile: "/nao/existe.crt", TLSKeyFile: "/nao/existe.key"})
	if err := s.Serve(context.Background(), ln); err == nil {
		t.Error("esperava erro com certificado inexistente")
	}
}

func TestCertReloader(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile := writeSelfSigned(t, dir, "primeiro")
	r, err := newCertReloader(certFile, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	cn := func() string {
		c, _ := r.GetCertificate(nil)
		x, _ := x509.ParseCertificate(c.Certificate[0])
		return x.Subject.CommonName
	}
	if got := cn(); got != "primeiro" {
		t.Fatalf("CN = %q", got)
	}

	// Renovação: novo arquivo com data de modificação diferente.
	writeSelfSigned(t, dir, "renovado")
	future := time.Now().Add(time.Minute)
	_ = os.Chtimes(certFile, future, future)
	r.checked = time.Time{} // ignora o intervalo de 30 s
	if got := cn(); got != "renovado" {
		t.Errorf("após renovação, CN = %q", got)
	}

	// Arquivo corrompido: mantém o certificado anterior.
	_ = os.WriteFile(certFile, []byte("lixo"), 0o600)
	past := time.Now().Add(2 * time.Minute)
	_ = os.Chtimes(certFile, past, past)
	r.checked = time.Time{}
	if got := cn(); got != "renovado" {
		t.Errorf("com arquivo inválido, CN = %q (deveria manter o anterior)", got)
	}
}
