package metrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// promClient fala com a API HTTP do Prometheus (ou compatível: Thanos,
// VictoriaMetrics, Mimir sem multi-inquilino).
type promClient struct {
	base string // termina em "/"
	http *http.Client
	// desc é o que a interface mostra: o endereço (sem senha) ou o Service.
	desc string
}

// newPromURL usa um endereço configurado. Usuário e senha no endereço viram
// autenticação básica.
func newPromURL(raw string) (*promClient, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("endereço do Prometheus inválido: %q (use http://host:porta)", raw)
	}
	desc := u.Redacted()
	if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	return &promClient{base: u.String(), http: &http.Client{Timeout: 30 * time.Second}, desc: desc}, nil
}

// promTarget é um Service candidato a Prometheus.
type promTarget struct {
	Namespace, Name string
	Port            int32
	Scheme          string
	score           int
}

func (t promTarget) String() string { return t.Namespace + "/" + t.Name }

// newPromService acessa o Service: de dentro do cluster, direto pelo DNS; de
// fora (modo local), pelo proxy do API server, com a credencial do kubeconfig.
func newPromService(t promTarget, cfg *rest.Config, inCluster bool) (*promClient, error) {
	if inCluster {
		return &promClient{
			base: fmt.Sprintf("%s://%s.%s.svc:%d/", t.Scheme, t.Name, t.Namespace, t.Port),
			http: &http.Client{Timeout: 30 * time.Second},
			desc: t.String(),
		}, nil
	}
	hc, err := rest.HTTPClientFor(cfg)
	if err != nil {
		return nil, err
	}
	host := strings.TrimSuffix(cfg.Host, "/")
	if !strings.Contains(host, "://") {
		host = "https://" + host
	}
	return &promClient{
		base: fmt.Sprintf("%s/api/v1/namespaces/%s/services/%s:%s:%d/proxy/", host, t.Namespace, t.Scheme, t.Name, t.Port),
		http: hc,
		desc: t.String(),
	}, nil
}

// Nomes que contêm "prometheus" mas não são o servidor de consultas (o
// kube-prometheus-stack cria vários desses).
var promExcluded = []string{
	"alertmanager", "pushgateway", "exporter", "kube-state-metrics", "operator", "adapter", "blackbox",
	"kubelet", "coredns", "kube-dns", "kube-proxy", "controller-manager", "scheduler", "etcd", "grafana", "webhook",
}

// discoverPrometheus procura Services de Prometheus no cluster, do mais
// provável ao menos provável.
func discoverPrometheus(ctx context.Context, cs kubernetes.Interface) ([]promTarget, error) {
	list, err := cs.CoreV1().Services(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	var out []promTarget
	for _, svc := range list.Items {
		if t, ok := promCandidate(svc); ok {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].score != out[j].score {
			return out[i].score > out[j].score
		}
		return out[i].String() < out[j].String()
	})
	return out, nil
}

func promCandidate(svc corev1.Service) (promTarget, bool) {
	name := strings.ToLower(svc.Name)
	l := svc.Labels
	labeled := l["app.kubernetes.io/name"] == "prometheus" || l["app"] == "prometheus"
	if !strings.Contains(name, "prometheus") && !labeled {
		return promTarget{}, false
	}
	for _, x := range promExcluded {
		if strings.Contains(name, x) {
			return promTarget{}, false
		}
	}
	if c := l["app.kubernetes.io/component"]; c != "" && c != "server" && c != "prometheus" {
		return promTarget{}, false
	}
	t := promTarget{Namespace: svc.Namespace, Name: svc.Name, Scheme: "http"}
	best := -1
	for _, p := range svc.Spec.Ports {
		pn := strings.ToLower(p.Name)
		s := -1
		switch {
		case p.Port == 9090 || p.TargetPort.IntVal == 9090 || p.TargetPort.StrVal == "web":
			s = 3
		case strings.Contains(pn, "web"):
			s = 2
		case strings.HasPrefix(pn, "http") || p.Port == 80 || p.Port == 443:
			s = 1
		}
		if s > best {
			best, t.Port = s, p.Port
			t.Scheme = "http"
			if strings.Contains(pn, "https") || p.Port == 443 {
				t.Scheme = "https"
			}
		}
	}
	if best < 0 {
		return promTarget{}, false
	}
	t.score = best
	if labeled {
		t.score += 3
	}
	if name == "prometheus" || strings.HasSuffix(name, "-prometheus") || strings.HasSuffix(name, "prometheus-server") {
		t.score += 2
	}
	if svc.Spec.ClusterIP != corev1.ClusterIPNone {
		t.score++
	}
	return t, true
}

// promValue é um par [instante, "valor"] da API.
type promValue struct {
	T float64
	V float64
}

func (p *promValue) UnmarshalJSON(b []byte) error {
	var raw [2]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if err := json.Unmarshal(raw[0], &p.T); err != nil {
		return err
	}
	var s string
	if err := json.Unmarshal(raw[1], &s); err != nil {
		return err
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return err
	}
	p.V = v
	return nil
}

type promSeries struct {
	Metric map[string]string `json:"metric"`
	Value  *promValue        `json:"value,omitempty"`  // consulta instantânea
	Values []promValue       `json:"values,omitempty"` // consulta por período
}

// errPromAPI: o endereço responde, mas não como um Prometheus.
var errPromAPI = errors.New("o endereço não respondeu como a API do Prometheus")

func (c *promClient) get(ctx context.Context, path string, params url.Values) ([]promSeries, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		// Sem o endereço com a consulta inteira, que só polui a mensagem.
		var ue *url.Error
		if errors.As(err, &ue) {
			return nil, ue.Err
		}
		return nil, err
	}
	defer resp.Body.Close()
	var body struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			Result []promSeries `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&body); err != nil {
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("%w (HTTP %d)", errPromAPI, resp.StatusCode)
		}
		return nil, errPromAPI
	}
	if body.Status != "success" {
		if body.Error == "" {
			return nil, fmt.Errorf("%w (HTTP %d)", errPromAPI, resp.StatusCode)
		}
		return nil, fmt.Errorf("Prometheus: %s", body.Error)
	}
	return body.Data.Result, nil
}

// query faz uma consulta instantânea e devolve o primeiro valor (ok=false se
// o resultado vier vazio).
func (c *promClient) query(ctx context.Context, q string) (float64, bool, error) {
	res, err := c.get(ctx, "api/v1/query", url.Values{"query": {q}})
	if err != nil || len(res) == 0 || res[0].Value == nil || math.IsNaN(res[0].Value.V) {
		return 0, false, err
	}
	return res[0].Value.V, true, nil
}

func (c *promClient) queryRange(ctx context.Context, q string, start, end time.Time, step time.Duration) ([]promSeries, error) {
	return c.get(ctx, "api/v1/query_range", url.Values{
		"query": {q},
		"start": {strconv.FormatInt(start.Unix(), 10)},
		"end":   {strconv.FormatInt(end.Unix(), 10)},
		"step":  {strconv.FormatFloat(step.Seconds(), 'f', -1, 64)},
	})
}
