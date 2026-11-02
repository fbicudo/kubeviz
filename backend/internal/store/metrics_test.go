package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kubeviz.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close(); now = time.Now })
	return s
}

func TestMetricsHistory(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	tiers := Tiers(30 * 24 * time.Hour)
	node := SeriesKey{Kind: "node", Name: "n1"}
	web := SeriesKey{Kind: "workload", Namespace: "demo", Name: "web", OwnerKind: "Deployment"}

	// Duas horas de amostras a cada 30 s: CPU sobe 1 milicore por amostra.
	start := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	for i := range 240 {
		ts := start.Add(time.Duration(i) * 30 * time.Second)
		err := s.WriteSamples(ctx, "kind", ts, map[SeriesKey]Sample{
			node: {CPU: float64(i), Mem: 1000, CPUCap: 4000, MemCap: 8000},
			web:  {CPU: 10, Mem: 20, CPUReq: 100, MemReq: 64},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	end := start.Add(2 * time.Hour)
	now = func() time.Time { return end }
	if err := s.Maintain(ctx, tiers); err != nil {
		t.Fatal(err)
	}

	// 1 h: nível de 30 s, 121 pontos (inclui as duas pontas).
	tier, pts, err := s.Query(ctx, "kind", node, end.Add(-time.Hour), end, tiers)
	if err != nil || tier.ID != 0 || len(pts) != 120 || pts[0].CPUCap != 4000 {
		t.Fatalf("1 h: nível %d, %d pontos, %v", tier.ID, len(pts), err)
	}
	// 7 dias: médias de 5 min; o primeiro intervalo tem as amostras 0..9 (média 4,5).
	tier, pts, err = s.Query(ctx, "kind", node, end.Add(-7*24*time.Hour), end, tiers)
	if err != nil || tier.ID != 1 || len(pts) != 24 || pts[0].CPU != 4.5 || pts[0].TS != start.Unix() {
		t.Fatalf("7 d: nível %d, %d pontos, primeiro %+v, %v", tier.ID, len(pts), pts[0], err)
	}
	// 30 dias: médias de 1 h (duas horas completas).
	tier, pts, err = s.Query(ctx, "kind", node, end.Add(-30*24*time.Hour), end, tiers)
	if err != nil || tier.ID != 2 || len(pts) != 2 || pts[0].CPU != 59.5 || pts[1].CPU != 179.5 {
		t.Fatalf("30 d: nível %d, %+v, %v", tier.ID, pts, err)
	}
	// Outra série e outro cluster não se misturam.
	if _, pts, _ := s.Query(ctx, "kind", web, end.Add(-time.Hour), end, tiers); len(pts) != 120 || pts[0].CPUReq != 100 {
		t.Errorf("workload: %d pontos", len(pts))
	}
	if _, pts, _ := s.Query(ctx, "outro", node, end.Add(-time.Hour), end, tiers); len(pts) != 0 {
		t.Errorf("outro cluster: %d pontos", len(pts))
	}

	// Rodar de novo não duplica as médias.
	if err := s.Maintain(ctx, tiers); err != nil {
		t.Fatal(err)
	}
	if _, pts, _ := s.Query(ctx, "kind", node, end.Add(-7*24*time.Hour), end, tiers); len(pts) != 24 {
		t.Errorf("manutenção repetida: %d pontos", len(pts))
	}

	// Dois dias depois: as amostras de 30 s venceram; as médias continuam.
	now = func() time.Time { return end.Add(48 * time.Hour) }
	if err := s.Maintain(ctx, tiers); err != nil {
		t.Fatal(err)
	}
	if _, pts, _ := s.Query(ctx, "kind", node, start, end, tiers); len(pts) != 0 {
		t.Errorf("amostras de 30 s deveriam ter vencido: %d", len(pts))
	}
	later := end.Add(48 * time.Hour)
	if _, pts, _ := s.Query(ctx, "kind", node, later.Add(-7*24*time.Hour), later, tiers); len(pts) != 24 {
		t.Errorf("médias de 5 min: %d", len(pts))
	}
	// 40 dias depois: tudo venceu e as séries vazias somem.
	now = func() time.Time { return end.Add(40 * 24 * time.Hour) }
	if err := s.Maintain(ctx, tiers); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.SeriesCount(ctx); n != 0 {
		t.Errorf("séries sem amostras: %d", n)
	}
	// E a série volta a ser criada quando o workload reaparece.
	if err := s.WriteSamples(ctx, "kind", end.Add(40*24*time.Hour), map[SeriesKey]Sample{web: {CPU: 1}}); err != nil {
		t.Fatalf("série recriada: %v", err)
	}
}

func TestReopenKeepsData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kubeviz.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	k := SeriesKey{Kind: "cluster"}
	ts := time.Now().Truncate(time.Second)
	if err := s.WriteSamples(context.Background(), "kind", ts, map[SeriesKey]Sample{k: {CPU: 7}}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path) // migrações já aplicadas não rodam de novo
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, pts, _ := s.Query(context.Background(), "kind", k, ts.Add(-time.Minute), ts, Tiers(0)); len(pts) != 1 || pts[0].CPU != 7 {
		t.Errorf("depois de reabrir: %+v", pts)
	}
	if s.Size() == 0 {
		t.Error("tamanho do banco")
	}
}
