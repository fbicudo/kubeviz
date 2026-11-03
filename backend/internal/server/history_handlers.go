package server

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	authzv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/metrics"
	"github.com/fbicudo/kubeviz/backend/internal/store"
)

// History é o histórico de métricas (coletor embutido).
type History interface {
	Status() metrics.Status
	History(ctx context.Context, key store.SeriesKey, span time.Duration) (store.Tier, []store.Point, error)
}

// Períodos aceitos pela interface.
var historyRanges = map[string]time.Duration{
	"15m": 15 * time.Minute, "1h": time.Hour, "6h": 6 * time.Hour,
	"24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour,
}

// canI pergunta ao cluster, com a credencial de quem consulta, se a operação
// é permitida (SelfSubjectAccessReview).
func canI(ctx context.Context, cfg *rest.Config, attrs authzv1.ResourceAttributes) (bool, error) {
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return false, err
	}
	r, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx,
		&authzv1.SelfSubjectAccessReview{Spec: authzv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &attrs}}, metav1.CreateOptions{})
	if err != nil {
		return false, err
	}
	return r.Status.Allowed, nil
}

// accessCache guarda as respostas por 60 s: os gráficos se atualizam sozinhos
// e não precisam perguntar ao cluster a cada vez.
type accessCache struct {
	mu      sync.Mutex
	entries map[string]accessEntry
}

type accessEntry struct {
	allowed bool
	expires time.Time
}

func (c *accessCache) get(key string) (bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expires) {
		return false, false
	}
	return e.allowed, true
}

func (c *accessCache) put(key string, allowed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil || len(c.entries) > 10_000 {
		c.entries = map[string]accessEntry{}
	}
	c.entries[key] = accessEntry{allowed: allowed, expires: time.Now().Add(time.Minute)}
}

// historyAllowed: nós e cluster exigem poder listar nós; namespaces,
// workloads e pods, poder listar pods no namespace. O histórico é coletado com a
// credencial do KubeViz, então quem não poderia ver os objetos não vê as séries.
func (s *Server) historyAllowed(r *http.Request, key store.SeriesKey) (bool, error) {
	attrs := authzv1.ResourceAttributes{Verb: "list", Resource: "nodes"}
	if key.Kind == "namespace" || key.Kind == "workload" || key.Kind == "pod" {
		ns := key.Namespace
		if key.Kind == "namespace" {
			ns = key.Name
		}
		attrs = authzv1.ResourceAttributes{Verb: "list", Resource: "pods", Namespace: ns}
	}
	sess := sessionFrom(r.Context())
	cacheKey := sess.ID + "|" + attrs.Resource + "|" + attrs.Namespace
	if allowed, ok := s.access.get(cacheKey); ok {
		return allowed, nil
	}
	check := s.opts.CanI
	if check == nil {
		check = canI
	}
	allowed, err := check(r.Context(), s.userConfig(sess), attrs)
	if err != nil {
		return false, err
	}
	s.access.put(cacheKey, allowed)
	return allowed, nil
}

func (s *Server) historyStatus(w http.ResponseWriter, r *http.Request) {
	if s.opts.History == nil {
		writeJSON(w, http.StatusOK, metrics.Status{State: "disabled"})
		return
	}
	writeJSON(w, http.StatusOK, s.opts.History.Status())
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	if s.opts.History == nil {
		writeError(w, http.StatusNotFound, "o histórico de métricas está desativado")
		return
	}
	q := r.URL.Query()
	span, ok := historyRanges[q.Get("range")]
	if !ok {
		writeError(w, http.StatusBadRequest, "período inválido (use 15m, 1h, 6h, 24h, 7d ou 30d)")
		return
	}
	key := store.SeriesKey{Kind: q.Get("kind"), Namespace: q.Get("namespace"), Name: q.Get("name"), OwnerKind: q.Get("ownerKind")}
	switch key.Kind {
	case "cluster":
		key.Namespace, key.Name, key.OwnerKind = "", "", ""
	case "node", "namespace":
		key.Namespace, key.OwnerKind = "", ""
		if key.Name == "" {
			writeError(w, http.StatusBadRequest, "informe o nome")
			return
		}
	case "pod":
		key.OwnerKind = ""
		if key.Namespace == "" || key.Name == "" {
			writeError(w, http.StatusBadRequest, "informe namespace e nome do pod")
			return
		}
	case "workload":
		if key.Namespace == "" || key.Name == "" || key.OwnerKind == "" {
			writeError(w, http.StatusBadRequest, "informe namespace, nome e tipo do workload")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, "tipo inválido (use cluster, node, namespace, workload ou pod)")
		return
	}
	allowed, err := s.historyAllowed(r, key)
	if err != nil {
		writeError(w, http.StatusBadGateway, "conferindo permissão: "+err.Error())
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "sem permissão para ver este histórico")
		return
	}
	tier, points, err := s.opts.History.History(r.Context(), key, span)
	if errors.Is(err, metrics.ErrPodNeedsPrometheus) {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Formato compacto: [ts, cpu, mem, cpuReq, memReq, cpuLim, memLim, cpuCap, memCap].
	rows := make([][9]float64, len(points))
	for i, p := range points {
		rows[i] = [9]float64{float64(p.TS), p.CPU, p.Mem, p.CPUReq, p.MemReq, p.CPULim, p.MemLim, p.CPUCap, p.MemCap}
	}
	writeJSON(w, http.StatusOK, map[string]any{"step": int(tier.Step / time.Second), "points": rows})
}
