package metrics

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/store"
)

// Estados do coletor (a interface explica cada um).
const (
	StateStarting  = "starting"
	StateOK        = "ok"
	StateMissing   = "missing"   // sem metrics-server
	StateForbidden = "forbidden" // credencial do KubeViz sem leitura
	StateError     = "error"
)

// Options configuram o coletor.
type Options struct {
	Interval  time.Duration
	Retention time.Duration
	// Target devolve a credencial e o nome do cluster atual (no modo local
	// o contexto pode mudar: o coletor acompanha).
	Target func() (*rest.Config, string)
	// NewSource é substituível nos testes.
	NewSource func(*rest.Config) (Source, error)
}

// Status é o que a interface mostra sobre o histórico.
type Status struct {
	State      string    `json:"state"`
	Error      string    `json:"error,omitempty"`
	Cluster    string    `json:"cluster"`
	LastSample time.Time `json:"lastSample,omitzero"`
	Interval   string    `json:"interval"`
	Retention  string    `json:"retention"`
	Series     int       `json:"series"`
	DBBytes    int64     `json:"dbBytes"`
}

// Collector amostra o cluster periodicamente e guarda no banco.
type Collector struct {
	log   *slog.Logger
	db    *store.Store
	opts  Options
	tiers []store.Tier

	mu      sync.Mutex
	status  Status
	source  Source
	cluster string
}

// NewCollector prepara o coletor (Run inicia).
func NewCollector(log *slog.Logger, db *store.Store, opts Options) *Collector {
	if opts.Interval <= 0 {
		opts.Interval = 30 * time.Second
	}
	if opts.NewSource == nil {
		opts.NewSource = NewKubeSource
	}
	c := &Collector{log: log, db: db, opts: opts, tiers: store.Tiers(opts.Retention)}
	c.status = Status{State: StateStarting, Interval: opts.Interval.String(), Retention: c.tiers[len(c.tiers)-1].Retention.String()}
	return c
}

// Run coleta até ctx ser cancelado.
func (c *Collector) Run(ctx context.Context) {
	tick := time.NewTicker(c.opts.Interval)
	defer tick.Stop()
	maintain := time.NewTicker(5 * time.Minute)
	defer maintain.Stop()
	defer c.stopSource()
	c.collect(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			c.collect(ctx)
		case <-maintain.C:
			if err := c.db.Maintain(ctx, c.tiers); err != nil && ctx.Err() == nil {
				c.log.Warn("manutenção do histórico", "erro", err)
			}
		}
	}
}

func (c *Collector) stopSource() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.source != nil {
		c.source.Stop()
		c.source = nil
	}
}

// collect faz uma amostra.
func (c *Collector) collect(ctx context.Context) {
	cfg, cluster := c.opts.Target()
	c.mu.Lock()
	if c.source == nil || cluster != c.cluster {
		if c.source != nil {
			c.source.Stop()
		}
		src, err := c.opts.NewSource(cfg)
		if err != nil {
			c.mu.Unlock()
			c.setError(cluster, err)
			return
		}
		c.source, c.cluster = src, cluster
		c.status.Cluster = cluster
	}
	src := c.source
	c.mu.Unlock()

	sctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	snap, err := src.Snapshot(sctx)
	if err != nil {
		if ctx.Err() == nil {
			c.setError(cluster, err)
		}
		return
	}
	now := time.Now().Truncate(time.Second)
	if err := c.db.WriteSamples(ctx, cluster, now, Aggregate(snap)); err != nil {
		c.setError(cluster, err)
		return
	}
	series, _ := c.db.SeriesCount(ctx)
	c.mu.Lock()
	if c.status.State != StateOK {
		c.log.Info("coletor de métricas ativo", "cluster", cluster, "nos", len(snap.Nodes), "pods", len(snap.Pods))
	}
	c.status.State, c.status.Error, c.status.LastSample, c.status.Series = StateOK, "", now, series
	c.mu.Unlock()
}

func (c *Collector) setError(cluster string, err error) {
	state := StateError
	switch {
	case errors.Is(err, ErrNoMetricsAPI):
		state = StateMissing
	case errors.Is(err, ErrForbidden):
		state = StateForbidden
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.status.State != state {
		c.log.Warn("coletor de métricas", "estado", state, "erro", err)
	}
	c.status.State, c.status.Error, c.status.Cluster = state, err.Error(), cluster
}

// Status devolve o estado atual.
func (c *Collector) Status() Status {
	c.mu.Lock()
	s := c.status
	c.mu.Unlock()
	s.DBBytes = c.db.Size()
	return s
}

// History devolve a série no período (para o cluster que está sendo coletado).
func (c *Collector) History(ctx context.Context, key store.SeriesKey, span time.Duration) (store.Tier, []store.Point, error) {
	c.mu.Lock()
	cluster := c.cluster
	c.mu.Unlock()
	if cluster == "" {
		_, cluster = c.opts.Target()
	}
	to := time.Now()
	tier, pts, err := c.db.Query(ctx, cluster, key, to.Add(-span), to, c.tiers)
	if tier.ID == 0 {
		tier.Step = c.opts.Interval // amostras cruas: o passo é o intervalo do coletor
	}
	return tier, pts, err
}
