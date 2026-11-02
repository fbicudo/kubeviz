//go:build envtest

package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	authnv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
	"github.com/fbicudo/kubeviz/backend/internal/auth/oidctest"
	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

// Login OIDC com impersonation contra um API server real: a ServiceAccount
// do KubeViz só consegue agir pelo usuário com a permissão "impersonate" (a
// mesma regra do Helm chart), e o RBAC aplicado é o do usuário.
func TestOIDCImpersonationWithRealAPIServer(t *testing.T) {
	env := &envtest.Environment{}
	cfg, err := env.Start()
	if err != nil {
		t.Fatalf("iniciando envtest (rode via make test-envtest): %v", err)
	}
	t.Cleanup(func() { _ = env.Stop() })
	ctx := context.Background()
	admin := kubernetes.NewForConfigOrDie(cfg)
	must := func(_ any, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	for _, ns := range []string{"kubeviz", "time-a", "time-b"} {
		must(admin.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}, metav1.CreateOptions{}))
	}
	must(admin.CoreV1().ServiceAccounts("kubeviz").Create(ctx, &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: "kubeviz"}}, metav1.CreateOptions{}))
	// Quem está no grupo "dev" do provedor lê pods em time-a.
	must(admin.RbacV1().Roles("time-a").Create(ctx, &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{Name: "ler-pods"},
		Rules:      []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"get", "list"}}},
	}, metav1.CreateOptions{}))
	must(admin.RbacV1().RoleBindings("time-a").Create(ctx, &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "dev-ler-pods"},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "ler-pods"},
		Subjects:   []rbacv1.Subject{{Kind: "Group", Name: "oidc:dev"}},
	}, metav1.CreateOptions{}))
	exp := int64(600)
	tr, err := admin.CoreV1().ServiceAccounts("kubeviz").CreateToken(ctx, "kubeviz",
		&authnv1.TokenRequest{Spec: authnv1.TokenRequestSpec{ExpirationSeconds: &exp}}, metav1.CreateOptions{})
	must(tr, err)

	// O KubeViz fala com a API como a própria ServiceAccount.
	saCfg := &rest.Config{Host: cfg.Host, TLSClientConfig: rest.TLSClientConfig{CAData: cfg.CAData}, BearerToken: tr.Status.Token}
	p := oidctest.New(t)
	o, err := auth.NewOIDC(auth.OIDCConfig{
		IssuerURL: p.URL, ClientID: oidctest.ClientID, ClientSecret: oidctest.ClientSecret,
		RedirectURL: "http://127.0.0.1:4466/auth/oidc/callback", Scopes: []string{"openid", "email"},
		UsernameClaim: "email", GroupsClaim: "groups", UsernamePrefix: "oidc:", GroupsPrefix: "oidc:", Mode: auth.OIDCImpersonate,
	})
	must(o, err)
	srv := httptest.NewServer(New(slog.New(slog.DiscardHandler), testAssets, cluster.NewInCluster(saCfg, "kubeviz-envtest"), Options{OIDC: o}).Handler())
	t.Cleanup(srv.Close)

	jar, _ := cookiejar.New(nil)
	c := &client{t: t, base: srv.URL, http: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	login := func() string {
		t.Helper()
		resp, err := c.http.Get(srv.URL + "/auth/oidc/login")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		back, _ := url.Parse(p.Authorize(t, resp.Header.Get("Location")))
		resp, err = c.http.Get(srv.URL + back.RequestURI())
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.Header.Get("Location")
	}

	t.Run("sem permissão de impersonation", func(t *testing.T) {
		if loc := login(); loc != "/?loginError=oidc_impersonate" {
			t.Errorf("retorno %q", loc)
		}
	})

	// Regra do Helm chart (deploy/helm/kubeviz/templates/rbac.yaml).
	must(admin.RbacV1().ClusterRoles().Create(ctx, &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{Name: "kubeviz-impersonate"},
		Rules:      []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"users", "groups"}, Verbs: []string{"impersonate"}}},
	}, metav1.CreateOptions{}))
	must(admin.RbacV1().ClusterRoleBindings().Create(ctx, &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "kubeviz-impersonate"},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "kubeviz-impersonate"},
		Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: "kubeviz", Namespace: "kubeviz"}},
	}, metav1.CreateOptions{}))

	t.Run("com permissão, vale o RBAC do usuário", func(t *testing.T) {
		if loc := login(); loc != "/" {
			t.Fatalf("retorno %q", loc)
		}
		if code, body := c.call("GET", "/api/k8s/api/v1/namespaces/time-a/pods", ""); code != 200 {
			t.Errorf("time-a: %d %s", code, body)
		}
		if code, _ := c.call("GET", "/api/k8s/api/v1/namespaces/time-b/pods", ""); code != 403 {
			t.Errorf("time-b: %d, quer 403", code)
		}
		// Cabeçalhos de impersonation do navegador não ampliam nada.
		if code, _ := c.call("GET", "/api/k8s/api/v1/namespaces/time-b/pods", "", "Impersonate-Group", "system:masters"); code != 403 {
			t.Errorf("time-b com Impersonate-Group: %d, quer 403", code)
		}
		code, body := c.call("POST", "/api/k8s/apis/authentication.k8s.io/v1/selfsubjectreviews", `{"apiVersion":"authentication.k8s.io/v1","kind":"SelfSubjectReview"}`)
		if code != 201 || !strings.Contains(body, `"username":"oidc:ana@exemplo.com"`) || !strings.Contains(body, `"oidc:dev"`) {
			t.Errorf("identidade no cluster: %d %s", code, body)
		}
	})
}

// Modo token contra um API server real que confia no provedor
// (AuthenticationConfiguration): o ID token é repassado e a identidade é a
// que o próprio API server extrai dele, com os prefixos que ele define.
func TestOIDCTokenModeWithRealAPIServer(t *testing.T) {
	p := oidctest.NewTLS(t)
	dir := t.TempDir()
	caFile := filepath.Join(dir, "idp-ca.crt")
	if err := os.WriteFile(caFile, p.CertPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	authn := fmt.Sprintf(`apiVersion: apiserver.config.k8s.io/v1
kind: AuthenticationConfiguration
jwt:
  - issuer:
      url: %s
      audiences: [%s]
      certificateAuthority: |
%s
    claimMappings:
      username: {claim: email, prefix: "oidc:"}
      groups: {claim: groups, prefix: "oidc:"}
`, p.URL, oidctest.ClientID, indentLines(string(p.CertPEM), "        "))
	authnFile := filepath.Join(dir, "authn.yaml")
	if err := os.WriteFile(authnFile, []byte(authn), 0o600); err != nil {
		t.Fatal(err)
	}

	env := &envtest.Environment{}
	env.ControlPlane.GetAPIServer().Configure().Set("authentication-config", authnFile)
	cfg, err := env.Start()
	if err != nil {
		t.Fatalf("iniciando envtest (rode via make test-envtest): %v", err)
	}
	t.Cleanup(func() { _ = env.Stop() })
	ctx := context.Background()
	admin := kubernetes.NewForConfigOrDie(cfg)
	for _, ns := range []string{"time-a", "time-b"} {
		if _, err := admin.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	// Role explícito: o envtest não roda o controller-manager, que monta o
	// ClusterRole "view" por agregação.
	if _, err := admin.RbacV1().Roles("time-a").Create(ctx, &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{Name: "ler-pods"},
		Rules:      []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"get", "list"}}},
	}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.RbacV1().RoleBindings("time-a").Create(ctx, &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "dev-ler-pods"},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "ler-pods"},
		Subjects:   []rbacv1.Subject{{Kind: "Group", Name: "oidc:dev"}},
	}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	o, err := auth.NewOIDC(auth.OIDCConfig{
		IssuerURL: p.URL, ClientID: oidctest.ClientID, ClientSecret: oidctest.ClientSecret, CAFile: caFile,
		RedirectURL: "http://127.0.0.1:4466/auth/oidc/callback", Scopes: []string{"openid", "email"},
		UsernameClaim: "email", GroupsClaim: "groups", Mode: auth.OIDCToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	// A configuração base (administrador) nunca é usada: só endereço e CA.
	srv := httptest.NewServer(New(slog.New(slog.DiscardHandler), testAssets, cluster.NewInCluster(cfg, "kubeviz-envtest"), Options{OIDC: o}).Handler())
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	c := &client{t: t, base: srv.URL, http: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}

	resp, err := c.http.Get(srv.URL + "/auth/oidc/login")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	back, _ := url.Parse(p.Authorize(t, resp.Header.Get("Location")))
	resp, err = c.http.Get(srv.URL + back.RequestURI())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if loc := resp.Header.Get("Location"); loc != "/" {
		t.Fatalf("retorno %q", loc)
	}

	code, body := c.call("GET", "/api/v1/auth/session", "")
	if code != 200 || !strings.Contains(body, `"username":"oidc:ana@exemplo.com"`) || !strings.Contains(body, `"oidc:dev"`) {
		t.Errorf("identidade: %d %s", code, body)
	}
	if code, body := c.call("GET", "/api/k8s/api/v1/namespaces/time-a/pods", ""); code != 200 {
		t.Errorf("time-a: %d %s", code, body)
	}
	if code, _ := c.call("GET", "/api/k8s/api/v1/namespaces/time-b/pods", ""); code != 403 {
		t.Errorf("time-b: %d, quer 403", code)
	}
}

func indentLines(s, prefix string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i, l := range lines {
		lines[i] = prefix + l
	}
	return strings.Join(lines, "\n")
}
