// Package cluster gerencia a conexão do KubeViz com a API do Kubernetes.
//
// Há dois modos:
//   - local: usa o kubeconfig do usuário e permite trocar de contexto. A troca
//     vale só para o KubeViz; o kubeconfig nunca é alterado.
//   - in-cluster: usa a ServiceAccount do pod (Helm chart).
package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// Mode indica de onde vêm as credenciais.
type Mode string

const (
	ModeLocal     Mode = "local"
	ModeInCluster Mode = "in-cluster"
)

var (
	// ErrUnknownContext indica um contexto que não existe no kubeconfig.
	ErrUnknownContext = errors.New("contexto não encontrado no kubeconfig")
	// ErrSwitchNotSupported indica tentativa de trocar contexto no modo in-cluster.
	ErrSwitchNotSupported = errors.New("troca de contexto disponível apenas no modo local")
)

// Options configura a conexão.
type Options struct {
	// Mode: "auto" (padrão), "local" ou "in-cluster". Em "auto", usa
	// in-cluster quando roda num pod e nenhum kubeconfig foi informado.
	Mode string
	// Kubeconfig é o caminho explícito; vazio = $KUBECONFIG ou ~/.kube/config.
	Kubeconfig string
	// Context inicial; vazio = current-context do kubeconfig.
	Context string
	// UserAgent enviado à API do Kubernetes.
	UserAgent string
}

// ContextInfo descreve um contexto do kubeconfig.
type ContextInfo struct {
	Name      string `json:"name"`
	Cluster   string `json:"cluster"`
	User      string `json:"user"`
	Namespace string `json:"namespace,omitempty"`
	Current   bool   `json:"current"`
}

// Info é o estado da conexão com o cluster.
type Info struct {
	Mode      Mode   `json:"mode"`
	Context   string `json:"context,omitempty"`
	Server    string `json:"server"`
	Reachable bool   `json:"reachable"`
	Version   string `json:"version,omitempty"`
	Platform  string `json:"platform,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Manager mantém a configuração ativa e permite trocá-la com segurança entre
// goroutines.
type Manager struct {
	mode      Mode
	userAgent string

	// Somente no modo local.
	kubeconfig *clientcmdapi.Config
	rules      *clientcmd.ClientConfigLoadingRules

	mu      sync.RWMutex
	current string
	config  *rest.Config
}

// New resolve o modo e carrega a configuração inicial.
func New(opts Options) (*Manager, error) {
	mode, err := resolveMode(opts)
	if err != nil {
		return nil, err
	}
	m := &Manager{mode: mode, userAgent: opts.UserAgent}

	if mode == ModeInCluster {
		cfg, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("configuração in-cluster: %w", err)
		}
		return NewInCluster(cfg, opts.UserAgent), nil
	}

	m.rules = clientcmd.NewDefaultClientConfigLoadingRules()
	m.rules.ExplicitPath = opts.Kubeconfig
	kc, err := m.rules.Load()
	if err != nil {
		return nil, fmt.Errorf("lendo kubeconfig: %w", err)
	}
	if len(kc.Contexts) == 0 {
		return nil, errors.New("nenhum contexto encontrado no kubeconfig; informe o arquivo com --kubeconfig")
	}
	m.kubeconfig = kc

	start := opts.Context
	if start == "" {
		start = kc.CurrentContext
	}
	if start == "" {
		return nil, errors.New("o kubeconfig não define current-context; informe um com --context")
	}
	if err := m.UseContext(start); err != nil {
		return nil, err
	}
	return m, nil
}

// NewInCluster cria um Manager no modo in-cluster a partir de cfg (a
// configuração da ServiceAccount do pod). Exportado para os testes de
// integração, que usam um API server do envtest.
func NewInCluster(cfg *rest.Config, userAgent string) *Manager {
	m := &Manager{mode: ModeInCluster, userAgent: userAgent}
	m.config = m.tune(rest.CopyConfig(cfg))
	return m
}

func resolveMode(opts Options) (Mode, error) {
	switch opts.Mode {
	case "", "auto":
		if opts.Kubeconfig == "" && os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
			return ModeInCluster, nil
		}
		return ModeLocal, nil
	case string(ModeLocal):
		return ModeLocal, nil
	case string(ModeInCluster):
		return ModeInCluster, nil
	default:
		return "", fmt.Errorf("modo inválido %q (use auto, local ou in-cluster)", opts.Mode)
	}
}

func (m *Manager) tune(cfg *rest.Config) *rest.Config {
	cfg.UserAgent = m.userAgent
	cfg.QPS = 50
	cfg.Burst = 100
	return cfg
}

// Mode devolve o modo de conexão.
func (m *Manager) Mode() Mode { return m.mode }

// UseContext troca o contexto ativo (somente modo local).
func (m *Manager) UseContext(name string) error {
	if m.mode != ModeLocal {
		return ErrSwitchNotSupported
	}
	if _, ok := m.kubeconfig.Contexts[name]; !ok {
		return fmt.Errorf("%w: %q", ErrUnknownContext, name)
	}
	cfg, err := clientcmd.NewNonInteractiveClientConfig(*m.kubeconfig, name, &clientcmd.ConfigOverrides{}, m.rules).ClientConfig()
	if err != nil {
		return fmt.Errorf("contexto %q: %w", name, err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.current = name
	m.config = m.tune(cfg)
	return nil
}

// Contexts lista os contextos do kubeconfig, em ordem alfabética. No modo
// in-cluster devolve lista vazia.
func (m *Manager) Contexts() []ContextInfo {
	if m.mode != ModeLocal {
		return []ContextInfo{}
	}
	m.mu.RLock()
	current := m.current
	m.mu.RUnlock()

	out := make([]ContextInfo, 0, len(m.kubeconfig.Contexts))
	for name, c := range m.kubeconfig.Contexts {
		out = append(out, ContextInfo{
			Name:      name,
			Cluster:   c.Cluster,
			User:      c.AuthInfo,
			Namespace: c.Namespace,
			Current:   name == current,
		})
	}
	slices.SortFunc(out, func(a, b ContextInfo) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// RESTConfig devolve uma cópia da configuração ativa.
func (m *Manager) RESTConfig() *rest.Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return rest.CopyConfig(m.config)
}

// ConfigForToken devolve a configuração ativa com as credenciais trocadas
// pelo token do usuário. Usada no modo in-cluster: cada requisição chega à
// API com a identidade de quem fez login, nunca com a da ServiceAccount do
// KubeViz. Mantém apenas endereço e CA do cluster.
func (m *Manager) ConfigForToken(token string) *rest.Config {
	m.mu.RLock()
	base := m.config
	m.mu.RUnlock()

	return &rest.Config{
		Host:    base.Host,
		APIPath: base.APIPath,
		TLSClientConfig: rest.TLSClientConfig{
			Insecure:   base.Insecure,
			ServerName: base.ServerName,
			CAFile:     base.CAFile,
			CAData:     base.CAData,
		},
		BearerToken: token,
		UserAgent:   base.UserAgent,
		QPS:         base.QPS,
		Burst:       base.Burst,
		Proxy:       base.Proxy,
	}
}

// Info consulta /version para saber se o cluster responde. Erros de conexão
// não são retornados como erro: aparecem em Info.Error.
func (m *Manager) Info(ctx context.Context) Info {
	m.mu.RLock()
	cfg := rest.CopyConfig(m.config)
	current := m.current
	m.mu.RUnlock()

	info := Info{Mode: m.mode, Context: current, Server: cfg.Host}

	v, err := serverVersion(ctx, cfg)
	if err != nil {
		info.Error = err.Error()
		return info
	}
	info.Reachable = true
	info.Version = v.GitVersion
	info.Platform = v.Platform
	return info
}

func serverVersion(ctx context.Context, cfg *rest.Config) (*version.Info, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	cfg.Timeout = 5 * time.Second
	client, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, err
	}
	// ServerVersion() não aceita context; a chamada direta respeita o timeout de ctx.
	raw, err := client.RESTClient().Get().AbsPath("/version").Do(ctx).Raw()
	if err != nil {
		return nil, fmt.Errorf("cluster inacessível: %w", err)
	}
	var v version.Info
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("resposta inesperada de /version: %w", err)
	}
	return &v, nil
}
