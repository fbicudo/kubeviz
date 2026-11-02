package server

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/auth"
)

const k8sPrefix = "/api/k8s"

// k8sProxy repassa /api/k8s/* para a API do Kubernetes com as credenciais da
// sessão. Quem autoriza cada operação é o RBAC do cluster.
func (s *Server) k8sProxy(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	cfg := s.userConfig(sess)

	// Terminais (exec/attach) ficam registrados: quem, onde e qual comando.
	if p := r.URL.Path; strings.HasSuffix(p, "/exec") || strings.HasSuffix(p, "/attach") {
		q := r.URL.Query()
		s.log.Info("sessão de terminal",
			"usuario", sessionUser(sess),
			"recurso", strings.TrimPrefix(p, k8sPrefix),
			"container", q.Get("container"),
			"comando", strings.Join(q["command"], " "),
			"origem", clientIP(r),
		)
	}

	target, err := url.Parse(cfg.Host)
	if err != nil || target.Host == "" {
		writeError(w, http.StatusBadGateway, "endereço do cluster inválido")
		return
	}
	transport, err := rest.TransportFor(cfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, "configurando acesso ao cluster: "+err.Error())
		return
	}

	proxy := &httputil.ReverseProxy{
		Transport: transport,
		// Sem buffer: watches e logs chegam ao navegador assim que gerados.
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, k8sPrefix)
			pr.Out.URL.RawPath = ""
			pr.SetURL(target)
			stripClientCredentials(pr.Out.Header)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			s.log.Warn("erro no proxy para o cluster", "caminho", r.URL.Path, "erro", err)
			writeError(w, http.StatusBadGateway, "cluster inacessível: "+err.Error())
		},
	}
	proxy.ServeHTTP(w, r)
}

// sessionUser identifica a sessão nos logs de auditoria.
func sessionUser(sess *auth.Session) string {
	switch {
	case sess == nil:
		return ""
	case sess.LocalUser != "":
		return sess.LocalUser
	case sess.User.Username != "":
		return sess.User.Username
	default:
		return "(kubeconfig)"
	}
}

// stripClientCredentials remove do pedido do navegador tudo o que poderia
// alterar a identidade usada no cluster. A credencial é sempre a da sessão,
// adicionada pelo transporte do client-go.
func stripClientCredentials(h http.Header) {
	h.Del("Authorization")
	h.Del("Cookie")
	for name := range h {
		if strings.HasPrefix(http.CanonicalHeaderKey(name), "Impersonate-") {
			h.Del(name)
		}
	}
}
