//go:build integration

package cluster

import (
	"context"
	"os"
	"testing"
)

// Requer um cluster acessível pelo kubeconfig padrão (ex.: kind).
// Rode com: make test-integration
func TestIntegrationRealCluster(t *testing.T) {
	m, err := New(Options{Mode: "local", Kubeconfig: os.Getenv("KUBECONFIG"), UserAgent: "kubeviz-integration"})
	if err != nil {
		t.Fatal(err)
	}
	info := m.Info(context.Background())
	if !info.Reachable {
		t.Fatalf("cluster inacessível: %+v", info)
	}
	t.Logf("contexto=%s servidor=%s versão=%s", info.Context, info.Server, info.Version)

	found := false
	for _, c := range m.Contexts() {
		found = found || (c.Current && c.Name == info.Context)
	}
	if !found {
		t.Errorf("contexto atual %q não marcado na lista", info.Context)
	}
}
