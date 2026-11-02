//go:build envtest

// Testes de RBAC contra um API server real (envtest: kube-apiserver + etcd).
// Rode com: make test-envtest
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	authnv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	"kubeviz.dev/kubeviz/internal/cluster"
)

const devUser = "system:serviceaccount:time-a:dev"

// rbacFixture cria dois namespaces e a ServiceAccount time-a/dev, que só pode
// ler pods em time-a. Devolve um token dessa ServiceAccount.
func rbacFixture(t *testing.T, ctx context.Context, admin kubernetes.Interface) string {
	t.Helper()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, ns := range []string{"time-a", "time-b"} {
		_, err := admin.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}, metav1.CreateOptions{})
		must(err)
	}
	_, err := admin.CoreV1().ServiceAccounts("time-a").Create(ctx, &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: "dev"}}, metav1.CreateOptions{})
	must(err)
	_, err = admin.RbacV1().Roles("time-a").Create(ctx, &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{Name: "ler-pods"},
		Rules:      []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"get", "list"}}},
	}, metav1.CreateOptions{})
	must(err)
	_, err = admin.RbacV1().RoleBindings("time-a").Create(ctx, &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "dev-ler-pods"},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "ler-pods"},
		Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: "dev", Namespace: "time-a"}},
	}, metav1.CreateOptions{})
	must(err)

	exp := int64(600)
	tr, err := admin.CoreV1().ServiceAccounts("time-a").CreateToken(ctx, "dev",
		&authnv1.TokenRequest{Spec: authnv1.TokenRequestSpec{ExpirationSeconds: &exp}}, metav1.CreateOptions{})
	must(err)
	return tr.Status.Token
}

type client struct {
	t    *testing.T
	base string
	http *http.Client
}

func (c *client) call(method, path, body string, headers ...string) (int, string) {
	c.t.Helper()
	req, err := http.NewRequest(method, c.base+path, bytes.NewBufferString(body))
	if err != nil {
		c.t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestRBACWithRealAPIServer(t *testing.T) {
	env := &envtest.Environment{}
	cfg, err := env.Start()
	if err != nil {
		t.Fatalf("iniciando envtest (rode via make test-envtest): %v", err)
	}
	t.Cleanup(func() { _ = env.Stop() })

	ctx := context.Background()
	admin := kubernetes.NewForConfigOrDie(cfg)
	token := rbacFixture(t, ctx, admin)

	// Modo in-cluster: a configuração base tem credenciais de administrador,
	// que nunca devem ser usadas nas requisições dos usuários.
	mgr := cluster.NewInCluster(cfg, "kubeviz-envtest")
	srv := httptest.NewServer(New(slog.New(slog.DiscardHandler), testAssets, mgr, Options{}).Handler())
	t.Cleanup(srv.Close)

	jar, _ := cookiejar.New(nil)
	c := &client{t: t, base: srv.URL, http: &http.Client{Jar: jar}}

	t.Run("sem sessão", func(t *testing.T) {
		if code, _ := c.call("GET", "/api/k8s/api/v1/namespaces/time-a/pods", ""); code != 401 {
			t.Errorf("status %d, quer 401", code)
		}
	})

	t.Run("token inválido", func(t *testing.T) {
		if code, body := c.call("POST", "/api/v1/auth/login", `{"token":"nao-e-um-token"}`); code != 401 {
			t.Errorf("status %d %s, quer 401", code, body)
		}
	})

	t.Run("login com token de ServiceAccount", func(t *testing.T) {
		code, body := c.call("POST", "/api/v1/auth/login", `{"token":"`+token+`"}`)
		if code != 200 {
			t.Fatalf("login: %d %s", code, body)
		}
		var s sessionResponse
		_ = json.Unmarshal([]byte(body), &s)
		if s.User == nil || s.User.Username != devUser {
			t.Fatalf("usuário = %+v, quer %s", s.User, devUser)
		}
	})

	cases := []struct {
		name, method, path, body string
		want                     int
	}{
		{"lê pods do próprio namespace", "GET", "/api/k8s/api/v1/namespaces/time-a/pods", "", 200},
		{"não lê pods de outro namespace", "GET", "/api/k8s/api/v1/namespaces/time-b/pods", "", 403},
		{"não lê secrets", "GET", "/api/k8s/api/v1/namespaces/time-a/secrets", "", 403},
		{"não lista namespaces", "GET", "/api/k8s/api/v1/namespaces", "", 403},
		{"não cria pods", "POST", "/api/k8s/api/v1/namespaces/time-a/pods",
			`{"apiVersion":"v1","kind":"Pod","metadata":{"name":"x"},"spec":{"containers":[{"name":"c","image":"busybox"}]}}`, 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, body := c.call(tc.method, tc.path, tc.body)
			if code != tc.want {
				t.Errorf("status %d, quer %d: %s", code, tc.want, body)
			}
			if tc.want == 403 && !strings.Contains(body, devUser) {
				t.Errorf("a recusa deveria citar %s (prova de que a identidade é a do usuário): %s", devUser, body)
			}
		})
	}

	t.Run("cabeçalhos de impersonation do navegador são descartados", func(t *testing.T) {
		code, body := c.call("GET", "/api/k8s/api/v1/namespaces/time-b/pods", "",
			"Impersonate-User", "system:admin", "Impersonate-Group", "system:masters")
		// Se o cabeçalho chegasse ao API server, a resposta seria
		// "cannot impersonate"; descartado, vale a identidade da sessão.
		if code != 403 || !strings.Contains(body, devUser) || !strings.Contains(body, "cannot list resource") ||
			strings.Contains(body, "impersonate") {
			t.Errorf("status %d: %s", code, body)
		}
	})

	t.Run("logout encerra o acesso", func(t *testing.T) {
		if code, _ := c.call("POST", "/api/v1/auth/logout", `{}`); code != 204 {
			t.Fatalf("logout: %d", code)
		}
		if code, _ := c.call("GET", "/api/k8s/api/v1/namespaces/time-a/pods", ""); code != 401 {
			t.Errorf("após logout: status %d, quer 401", code)
		}
	})
}
