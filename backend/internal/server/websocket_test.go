package server

import (
	"bufio"
	"bytes"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeExecServer imita o API server: responde 101 e devolve com eco o que receber.
func fakeExecServer(t *testing.T, gotAuth *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*gotAuth = r.Header.Get("Authorization")
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: v5.channel.k8s.io\r\n\r\n")
		_ = rw.Flush()
		buf := make([]byte, 4)
		if _, err := io.ReadFull(rw, buf); err == nil {
			_, _ = conn.Write(buf)
		}
	}))
}

// upgrade abre uma conexão TCP crua e pede o upgrade, como um navegador faria.
func upgrade(t *testing.T, addr, cookie, origin string) (*http.Response, net.Conn, *bufio.Reader) {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	req := "GET /api/k8s/api/v1/namespaces/demo/pods/web/exec?container=app&command=sh&stdin=true&tty=true HTTP/1.1\r\n" +
		"Host: " + addr + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: v5.channel.k8s.io\r\n" +
		"Cookie: " + cookie + "\r\n"
	if origin != "" {
		req += "Origin: " + origin + "\r\n"
	}
	_, _ = conn.Write([]byte(req + "\r\n"))
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	return resp, conn, br
}

func TestProxyUpgradesWebSocketForExec(t *testing.T) {
	var gotAuth string
	api := fakeExecServer(t, &gotAuth)
	defer api.Close()

	fc := newFakeCluster()
	fc.host = api.URL
	var logs bytes.Buffer
	s := New(slog.New(slog.NewTextHandler(&logs, nil)), testAssets, fc, Options{WhoAmI: fakeWhoAmI})
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")
	cookie := loggedIn(s, "")

	resp, conn, br := upgrade(t, addr, cookie, "http://"+addr)
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status %d, quer 101", resp.StatusCode)
	}
	if gotAuth != "Bearer kubeconfig-token" {
		t.Errorf("credencial repassada = %q", gotAuth)
	}
	_, _ = conn.Write([]byte("ping"))
	echo := make([]byte, 4)
	if _, err := io.ReadFull(br, echo); err != nil || string(echo) != "ping" {
		t.Fatalf("eco pelo túnel: %q %v", echo, err)
	}
	if !strings.Contains(logs.String(), "sessão de terminal") || !strings.Contains(logs.String(), "comando=sh") {
		t.Errorf("sessão de terminal não registrada no log: %s", logs.String())
	}
}

func TestWebSocketFromOtherOriginIsRefused(t *testing.T) {
	var gotAuth string
	api := fakeExecServer(t, &gotAuth)
	defer api.Close()
	fc := newFakeCluster()
	fc.host = api.URL
	s := newServer(fc, Options{})
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")

	resp, _, _ := upgrade(t, addr, loggedIn(s, ""), "https://evil.example")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("WebSocket de outra origem: status %d, quer 403", resp.StatusCode)
	}
	if gotAuth != "" {
		t.Error("o pedido de outra origem não deveria chegar ao cluster")
	}

	resp, _, _ = upgrade(t, addr, sessionCookie+"=invalido", "http://"+addr)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("sem sessão: status %d, quer 401", resp.StatusCode)
	}
}
