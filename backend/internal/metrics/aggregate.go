// Package metrics é o coletor embutido: amostra o metrics-server em segundo
// plano e guarda o histórico de CPU e memória do cluster, dos nós, dos
// namespaces e dos workloads (ver internal/store).
package metrics

import (
	"strings"

	"github.com/fbicudo/kubeviz/backend/internal/store"
)

// NodeInfo é o que o coletor precisa de um nó.
type NodeInfo struct {
	Name           string
	CPUCap, MemCap float64 // alocável: milicores e bytes
}

// PodInfo é o que o coletor precisa de um pod.
type PodInfo struct {
	Namespace, Name, Node string
	// Active: pods terminados (Succeeded/Failed) não reservam recursos.
	Active         bool
	OwnerKind      string
	OwnerName      string
	TemplateHash   string
	CPUReq, MemReq float64
	CPULim, MemLim float64
}

// Usage é o uso medido pelo metrics-server.
type Usage struct{ CPU, Mem float64 }

// Snapshot é o estado do cluster num instante.
type Snapshot struct {
	Nodes     []NodeInfo
	Pods      []PodInfo
	NodeUsage map[string]Usage // por nome do nó
	PodUsage  map[string]Usage // por "namespace/nome"
}

// Workload dono do pod (mesma regra da interface): pods de Deployment
// pertencem a um ReplicaSet "<deployment>-<hash>"; pods estáticos (dono = nó)
// e sem dono contam como eles mesmos.
func workloadOf(p PodInfo) (kind, name string) {
	switch {
	case p.OwnerKind == "" || p.OwnerKind == "Node":
		return "Pod", p.Name
	case p.OwnerKind == "ReplicaSet" && p.TemplateHash != "" && strings.HasSuffix(p.OwnerName, "-"+p.TemplateHash):
		return "Deployment", strings.TrimSuffix(p.OwnerName, "-"+p.TemplateHash)
	}
	return p.OwnerKind, p.OwnerName
}

func add(m map[store.SeriesKey]store.Sample, k store.SeriesKey, f func(*store.Sample)) {
	s := m[k]
	f(&s)
	m[k] = s
}

// Aggregate transforma o estado do cluster nas amostras de cada série.
func Aggregate(snap Snapshot) map[store.SeriesKey]store.Sample {
	out := map[store.SeriesKey]store.Sample{}
	cluster := store.SeriesKey{Kind: "cluster"}
	out[cluster] = store.Sample{}
	for _, n := range snap.Nodes {
		u := snap.NodeUsage[n.Name]
		k := store.SeriesKey{Kind: "node", Name: n.Name}
		add(out, k, func(s *store.Sample) { s.CPU, s.Mem, s.CPUCap, s.MemCap = u.CPU, u.Mem, n.CPUCap, n.MemCap })
		add(out, cluster, func(s *store.Sample) {
			s.CPU += u.CPU
			s.Mem += u.Mem
			s.CPUCap += n.CPUCap
			s.MemCap += n.MemCap
		})
	}
	for _, p := range snap.Pods {
		u := snap.PodUsage[p.Namespace+"/"+p.Name]
		var req, lim [2]float64
		if p.Active {
			req, lim = [2]float64{p.CPUReq, p.MemReq}, [2]float64{p.CPULim, p.MemLim}
		}
		sum := func(s *store.Sample) {
			s.CPU += u.CPU
			s.Mem += u.Mem
			s.CPUReq += req[0]
			s.MemReq += req[1]
			s.CPULim += lim[0]
			s.MemLim += lim[1]
		}
		wkind, wname := workloadOf(p)
		add(out, store.SeriesKey{Kind: "namespace", Name: p.Namespace}, sum)
		add(out, store.SeriesKey{Kind: "workload", Namespace: p.Namespace, Name: wname, OwnerKind: wkind}, sum)
		// Reservas por nó e no cluster (o uso deles vem do próprio nó).
		reserve := func(s *store.Sample) {
			s.CPUReq += req[0]
			s.MemReq += req[1]
			s.CPULim += lim[0]
			s.MemLim += lim[1]
		}
		if p.Node != "" {
			if _, ok := out[store.SeriesKey{Kind: "node", Name: p.Node}]; ok {
				add(out, store.SeriesKey{Kind: "node", Name: p.Node}, reserve)
			}
		}
		add(out, cluster, reserve)
	}
	return out
}
