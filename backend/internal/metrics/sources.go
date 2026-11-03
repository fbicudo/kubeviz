package metrics

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/store"
)

// Estados da detecção do Prometheus.
const (
	PromSearching   = "searching"
	PromOK          = "ok"
	PromNotFound    = "notfound"
	PromIncomplete  = "incomplete"  // falta cAdvisor ou kube-state-metrics
	PromUnreachable = "unreachable" // configurado, mas não responde
)

// PromStatus é o que a interface mostra sobre o Prometheus.
type PromStatus struct {
	State   string   `json:"state"`
	Target  string   `json:"target,omitempty"`
	Missing []string `json:"missing,omitempty"`
	Error   string   `json:"error,omitempty"`
}

// HistoryOptions configuram a escolha da fonte do histórico.
type HistoryOptions struct {
	// Prometheus: "auto" (procura um Service), "off" ou um endereço.
	Prometheus string
	// InCluster: os Services são acessados direto pelo DNS; senão, pelo
	// proxy do API server.
	InCluster bool
	Target    func() (*rest.Config, string)
}

// History escolhe de onde vem o histórico: do Prometheus, quando há um com
// os dados necessários, ou do coletor embutido (que fica pausado enquanto o
// Prometheus responde, para não gastar memória com o mesmo trabalho).
type History struct {
	log       *slog.Logger
	collector *Collector // nil = desligado
	opts      HistoryOptions

	mu         sync.Mutex
	prom       *promBackend
	pstatus    PromStatus
	cluster    string
	lastSearch time.Time
}

// NewHistory prepara a escolha da fonte (Run acompanha o Prometheus).
func NewHistory(log *slog.Logger, collector *Collector, opts HistoryOptions) *History {
	if opts.Prometheus == "" {
		opts.Prometheus = "auto"
	}
	h := &History{log: log, collector: collector, opts: opts, pstatus: PromStatus{State: PromSearching}}
	if opts.Prometheus == "off" {
		h.pstatus = PromStatus{}
	}
	if collector != nil {
		collector.opts.Paused = h.usingPrometheus
	}
	return h
}

func (h *History) usingPrometheus() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.prom != nil
}

// Run roda o coletor e confere o Prometheus a cada minuto, até ctx ser
// cancelado. A primeira conferência vem antes do coletor, para ele não
// começar à toa quando houver Prometheus.
func (h *History) Run(ctx context.Context) {
	if h.opts.Prometheus == "off" {
		if h.collector != nil {
			h.collector.Run(ctx)
		}
		return
	}
	h.check(ctx)
	if h.collector != nil {
		go h.collector.Run(ctx)
	}
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			h.check(ctx)
		}
	}
}

// check confere o Prometheus em uso ou procura outro. A busca por Services
// roda a cada 5 min enquanto nada é encontrado (ou ao trocar de contexto).
func (h *History) check(ctx context.Context) {
	cfg, cluster := h.opts.Target()
	h.mu.Lock()
	changed := cluster != h.cluster
	cur := h.prom
	recent := time.Since(h.lastSearch) < 5*time.Minute
	h.mu.Unlock()

	if cur != nil && !changed {
		missing, err := cur.probe(ctx)
		if err == nil && len(missing) == 0 {
			return
		}
		if ctx.Err() != nil {
			return
		}
		// Uma falha passageira não troca a fonte: a busca abaixo confere de novo.
		h.log.Debug("Prometheus falhou na conferência", "prometheus", cur.c.desc, "erro", err, "falta", missing)
		recent = false
	}
	if cur == nil && !changed && recent && h.opts.Prometheus == "auto" {
		return
	}

	backend, st := h.find(ctx, cfg)
	if ctx.Err() != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.cluster, h.lastSearch = cluster, time.Now()
	if backend != nil && (h.prom == nil || h.prom.c.desc != backend.c.desc || changed) {
		h.log.Info("histórico de métricas pelo Prometheus", "prometheus", backend.c.desc, "cluster", cluster, "uso_do_no", map[bool]string{true: "cgroup do nó", false: "soma dos pods"}[backend.nodeCgroup])
	}
	if backend == nil && h.prom != nil && !changed {
		h.log.Warn("Prometheus deixou de responder; o histórico volta ao coletor embutido", "prometheus", h.prom.c.desc, "estado", st.State, "falta", st.Missing, "erro", st.Error)
	} else if backend == nil && !samePromStatus(st, h.pstatus) && st.State != PromNotFound {
		h.log.Warn("Prometheus não usado no histórico", "estado", st.State, "prometheus", st.Target, "falta", st.Missing, "erro", st.Error)
	}
	h.prom, h.pstatus = backend, st
}

func samePromStatus(a, b PromStatus) bool {
	return a.State == b.State && a.Target == b.Target && a.Error == b.Error && strings.Join(a.Missing, ",") == strings.Join(b.Missing, ",")
}

// find usa o endereço configurado ou procura os Services. Entre vários
// candidatos, fica o primeiro completo; senão, o estado do mais provável.
func (h *History) find(ctx context.Context, cfg *rest.Config) (*promBackend, PromStatus) {
	var clients []*promClient
	if h.opts.Prometheus != "auto" {
		c, err := newPromURL(h.opts.Prometheus)
		if err != nil {
			return nil, PromStatus{State: PromUnreachable, Error: err.Error()}
		}
		clients = append(clients, c)
	} else {
		cs, err := kubernetes.NewForConfig(cfg)
		if err != nil {
			return nil, PromStatus{State: PromNotFound, Error: err.Error()}
		}
		lctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		targets, err := discoverPrometheus(lctx, cs)
		cancel()
		if err != nil {
			return nil, PromStatus{State: PromNotFound, Error: "procurando Services: " + err.Error()}
		}
		for i, t := range targets {
			if i == 5 {
				break
			}
			if c, err := newPromService(t, cfg, h.opts.InCluster); err == nil {
				clients = append(clients, c)
			}
		}
	}
	first := PromStatus{State: PromNotFound}
	for i, c := range clients {
		b := &promBackend{c: c}
		missing, err := b.probe(ctx)
		st := PromStatus{State: PromOK, Target: c.desc}
		switch {
		case err != nil:
			st.State, st.Error = PromUnreachable, err.Error()
		case len(missing) > 0:
			st.State, st.Missing = PromIncomplete, missing
		default:
			return b, st
		}
		if i == 0 || (first.State == PromUnreachable && st.State == PromIncomplete) {
			first = st
		}
	}
	return nil, first
}

// Status combina o estado do coletor e o do Prometheus.
func (h *History) Status() Status {
	s := Status{State: "disabled"}
	if h.collector != nil {
		s = h.collector.Status()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	s.Source = "collector"
	if h.opts.Prometheus != "off" {
		ps := h.pstatus
		s.Prometheus = &ps
	}
	if h.prom != nil {
		s.State, s.Error, s.Source = StateOK, "", "prometheus"
		if h.cluster != "" {
			s.Cluster = h.cluster
		}
	} else if h.collector == nil && h.pstatus.State == PromSearching {
		s.State = StateStarting
	}
	return s
}

// ErrNoHistory: nem coletor nem Prometheus.
var ErrNoHistory = errors.New("o histórico de métricas está desativado")

// ErrPodNeedsPrometheus: o coletor embutido não guarda pods individuais.
var ErrPodNeedsPrometheus = errors.New("o histórico de pods individuais requer o Prometheus; o coletor embutido guarda só cluster, nós, namespaces e workloads")

// History devolve a série no período, da fonte em uso.
func (h *History) History(ctx context.Context, key store.SeriesKey, span time.Duration) (store.Tier, []store.Point, error) {
	h.mu.Lock()
	prom := h.prom
	h.mu.Unlock()
	if prom != nil {
		tier, pts, err := prom.history(ctx, key, span)
		if err != nil {
			return tier, nil, errors.New("consultando o Prometheus: " + strings.TrimPrefix(err.Error(), "Prometheus: "))
		}
		return tier, pts, nil
	}
	if key.Kind == "pod" {
		return store.Tier{}, nil, ErrPodNeedsPrometheus
	}
	if h.collector == nil {
		return store.Tier{}, nil, ErrNoHistory
	}
	return h.collector.History(ctx, key, span)
}
