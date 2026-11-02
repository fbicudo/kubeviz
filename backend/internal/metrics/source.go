package metrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
)

// Erros que viram estados do coletor.
var (
	ErrNoMetricsAPI = errors.New("o cluster não tem o metrics-server (API metrics.k8s.io)")
	ErrForbidden    = errors.New("sem permissão para ler nós, pods ou métricas")
)

// Source fornece o estado do cluster ao coletor.
type Source interface {
	Snapshot(ctx context.Context) (Snapshot, error)
	Stop()
}

// kubeSource acompanha nós e pods por watch (informers), guardando só o
// necessário, e lê as métricas do metrics-server a cada amostra.
type kubeSource struct {
	cs     kubernetes.Interface
	stop   chan struct{}
	once   sync.Once
	pods   cache.SharedIndexInformer
	nodes  cache.SharedIndexInformer
	synced bool
}

// NewKubeSource inicia os informers com a credencial do coletor.
func NewKubeSource(cfg *rest.Config) (Source, error) {
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	f := informers.NewSharedInformerFactory(cs, 0)
	s := &kubeSource{cs: cs, stop: make(chan struct{}), pods: f.Core().V1().Pods().Informer(), nodes: f.Core().V1().Nodes().Informer()}
	// Só o que o coletor usa fica na memória (milhares de pods).
	if err := s.pods.SetTransform(slimPod); err != nil {
		return nil, err
	}
	if err := s.nodes.SetTransform(slimNode); err != nil {
		return nil, err
	}
	f.Start(s.stop)
	return s, nil
}

func (s *kubeSource) Stop() { s.once.Do(func() { close(s.stop) }) }

func slimPod(obj any) (any, error) {
	p, ok := obj.(*corev1.Pod)
	if !ok {
		return obj, nil
	}
	slim := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: p.Name, Namespace: p.Namespace, UID: p.UID, ResourceVersion: p.ResourceVersion, OwnerReferences: p.OwnerReferences},
		Spec:       corev1.PodSpec{NodeName: p.Spec.NodeName},
		Status:     corev1.PodStatus{Phase: p.Status.Phase},
	}
	if h := p.Labels["pod-template-hash"]; h != "" {
		slim.Labels = map[string]string{"pod-template-hash": h}
	}
	for _, c := range p.Spec.Containers {
		slim.Spec.Containers = append(slim.Spec.Containers, corev1.Container{Name: c.Name, Resources: c.Resources})
	}
	return slim, nil
}

func slimNode(obj any) (any, error) {
	n, ok := obj.(*corev1.Node)
	if !ok {
		return obj, nil
	}
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: n.Name, UID: n.UID, ResourceVersion: n.ResourceVersion},
		Status:     corev1.NodeStatus{Allocatable: n.Status.Allocatable, Conditions: n.Status.Conditions},
	}, nil
}

func (s *kubeSource) Snapshot(ctx context.Context) (Snapshot, error) {
	if !s.synced {
		c, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if !cache.WaitForCacheSync(c.Done(), s.pods.HasSynced, s.nodes.HasSynced) {
			// Os informers repetem sozinhos; sem sincronizar, falta permissão ou o cluster não responde.
			return Snapshot{}, fmt.Errorf("lendo nós e pods (sem permissão ou cluster inacessível): %w", ErrForbidden)
		}
		s.synced = true
	}
	var snap Snapshot
	for _, o := range s.nodes.GetStore().List() {
		n := o.(*corev1.Node)
		snap.Nodes = append(snap.Nodes, NodeInfo{Name: n.Name, CPUCap: milli(n.Status.Allocatable, corev1.ResourceCPU), MemCap: value(n.Status.Allocatable, corev1.ResourceMemory)})
	}
	for _, o := range s.pods.GetStore().List() {
		p := o.(*corev1.Pod)
		info := PodInfo{Namespace: p.Namespace, Name: p.Name, Node: p.Spec.NodeName, TemplateHash: p.Labels["pod-template-hash"],
			Active: p.Status.Phase != corev1.PodSucceeded && p.Status.Phase != corev1.PodFailed}
		if o := metav1.GetControllerOf(p); o != nil {
			info.OwnerKind, info.OwnerName = o.Kind, o.Name
		}
		for _, c := range p.Spec.Containers {
			info.CPUReq += milli(c.Resources.Requests, corev1.ResourceCPU)
			info.MemReq += value(c.Resources.Requests, corev1.ResourceMemory)
			info.CPULim += milli(c.Resources.Limits, corev1.ResourceCPU)
			info.MemLim += value(c.Resources.Limits, corev1.ResourceMemory)
		}
		snap.Pods = append(snap.Pods, info)
	}
	var err error
	if snap.NodeUsage, err = s.usage(ctx, "nodes"); err != nil {
		return snap, err
	}
	snap.PodUsage, err = s.usage(ctx, "pods")
	return snap, err
}

// usage lê /apis/metrics.k8s.io/v1beta1/{nodes,pods}.
func (s *kubeSource) usage(ctx context.Context, what string) (map[string]Usage, error) {
	raw, err := s.cs.CoreV1().RESTClient().Get().AbsPath("/apis/metrics.k8s.io/v1beta1/" + what).DoRaw(ctx)
	switch {
	case apierrors.IsNotFound(err):
		return nil, ErrNoMetricsAPI
	case apierrors.IsForbidden(err):
		return nil, ErrForbidden
	case err != nil:
		return nil, fmt.Errorf("lendo métricas de %s: %w", what, err)
	}
	var list struct {
		Items []struct {
			Metadata   metav1.ObjectMeta   `json:"metadata"`
			Usage      corev1.ResourceList `json:"usage"`
			Containers []struct {
				Usage corev1.ResourceList `json:"usage"`
			} `json:"containers"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	out := make(map[string]Usage, len(list.Items))
	for _, it := range list.Items {
		u := Usage{CPU: milli(it.Usage, corev1.ResourceCPU), Mem: value(it.Usage, corev1.ResourceMemory)}
		for _, c := range it.Containers {
			u.CPU += milli(c.Usage, corev1.ResourceCPU)
			u.Mem += value(c.Usage, corev1.ResourceMemory)
		}
		key := it.Metadata.Name
		if it.Metadata.Namespace != "" {
			key = it.Metadata.Namespace + "/" + it.Metadata.Name
		}
		out[key] = u
	}
	return out, nil
}

func milli(l corev1.ResourceList, name corev1.ResourceName) float64 {
	if q, ok := l[name]; ok {
		return float64(q.MilliValue())
	}
	return 0
}

func value(l corev1.ResourceList, name corev1.ResourceName) float64 {
	if q, ok := l[name]; ok {
		return q.AsApproximateFloat64()
	}
	return 0
}
