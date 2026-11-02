package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Níveis de resolução do histórico: cada um guarda médias de um intervalo
// por um período, para que qualquer consulta tenha no máximo ~3.000 pontos.
type Tier struct {
	ID        int
	Step      time.Duration
	Retention time.Duration
}

// Tiers: 30 s por 24 h, 5 min por 7 dias, 1 h pelo período configurado.
func Tiers(retention time.Duration) []Tier {
	if retention < 7*24*time.Hour {
		retention = 7 * 24 * time.Hour
	}
	return []Tier{
		{0, 30 * time.Second, 24 * time.Hour},
		{1, 5 * time.Minute, 7 * 24 * time.Hour},
		{2, time.Hour, retention},
	}
}

// SeriesKey identifica o que foi medido.
type SeriesKey struct {
	// Kind: cluster, node, namespace ou workload.
	Kind      string
	Namespace string
	Name      string
	// OwnerKind: tipo do workload (Deployment, StatefulSet…).
	OwnerKind string
}

type seriesKey struct {
	cluster string
	SeriesKey
}

// Sample é uma amostra de CPU (milicores) e memória (bytes).
type Sample struct {
	CPU, Mem       float64
	CPUReq, MemReq float64
	CPULim, MemLim float64
	// CPUCap e MemCap: capacidade alocável (nós e cluster).
	CPUCap, MemCap float64
}

// Point é uma amostra num instante.
type Point struct {
	TS int64 // segundos Unix
	Sample
}

func (s *Store) seriesID(ctx context.Context, tx *sql.Tx, cluster string, k SeriesKey) (int64, error) {
	key := seriesKey{cluster, k}
	s.mu.Lock()
	id, ok := s.series[key]
	s.mu.Unlock()
	if ok {
		return id, nil
	}
	err := tx.QueryRowContext(ctx, `INSERT INTO series (cluster, kind, namespace, name, owner_kind) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (cluster, kind, namespace, name, owner_kind) DO UPDATE SET kind = excluded.kind RETURNING id`,
		cluster, k.Kind, k.Namespace, k.Name, k.OwnerKind).Scan(&id)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	s.series[key] = id
	s.mu.Unlock()
	return id, nil
}

// WriteSamples grava as amostras de um instante (nível de 30 s).
func (s *Store) WriteSamples(ctx context.Context, cluster string, ts time.Time, samples map[SeriesKey]Sample) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT OR REPLACE INTO samples (series, tier, ts, cpu, mem, cpu_req, mem_req, cpu_lim, mem_lim, cpu_cap, mem_cap)
		VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for k, v := range samples {
		id, err := s.seriesID(ctx, tx, cluster, k)
		if err != nil {
			return err
		}
		if _, err := stmt.ExecContext(ctx, id, ts.Unix(), v.CPU, v.Mem, v.CPUReq, v.MemReq, v.CPULim, v.MemLim, v.CPUCap, v.MemCap); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Maintain calcula as médias dos níveis mais grossos para os intervalos já
// completos e apaga o que passou do prazo de cada nível.
func (s *Store) Maintain(ctx context.Context, tiers []Tier) error {
	t := now()
	for i := 1; i < len(tiers); i++ {
		src, dst := tiers[i-1], tiers[i]
		step := int64(dst.Step / time.Second)
		key := fmt.Sprintf("rollup%d_until", dst.ID)
		from, err := s.meta(ctx, key)
		if err != nil {
			return err
		}
		until := t.Unix() / step * step // só intervalos completos
		if from == 0 {
			from = until - int64(src.Retention/time.Second)
		}
		if until <= from {
			continue
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT OR REPLACE INTO samples (series, tier, ts, cpu, mem, cpu_req, mem_req, cpu_lim, mem_lim, cpu_cap, mem_cap)
			SELECT series, ?, (ts / ?) * ?, AVG(cpu), AVG(mem), AVG(cpu_req), AVG(mem_req), AVG(cpu_lim), AVG(mem_lim), AVG(cpu_cap), AVG(mem_cap)
			FROM samples WHERE tier = ? AND ts >= ? AND ts < ? GROUP BY series, ts / ?`,
			dst.ID, step, step, src.ID, from, until, step)
		if err == nil {
			err = setMeta(ctx, tx, key, until)
		}
		if err != nil {
			tx.Rollback()
			return fmt.Errorf("médias do nível %d: %w", dst.ID, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	for _, tier := range tiers {
		if _, err := s.db.ExecContext(ctx, `DELETE FROM samples WHERE tier = ? AND ts < ?`, tier.ID, t.Add(-tier.Retention).Unix()); err != nil {
			return err
		}
	}
	// Séries sem nenhuma amostra (workload apagado há mais que o prazo).
	if _, err := s.db.ExecContext(ctx, `DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series FROM samples)`); err != nil {
		return err
	}
	s.mu.Lock()
	s.series = map[seriesKey]int64{}
	s.mu.Unlock()
	return nil
}

// TierFor escolhe o nível mais fino que cobre o período inteiro.
func TierFor(tiers []Tier, span time.Duration) Tier {
	for _, t := range tiers {
		if span <= t.Retention {
			return t
		}
	}
	return tiers[len(tiers)-1]
}

// Query devolve os pontos da série no período, no nível adequado a ele.
func (s *Store) Query(ctx context.Context, cluster string, k SeriesKey, from, to time.Time, tiers []Tier) (Tier, []Point, error) {
	tier := TierFor(tiers, to.Sub(from))
	rows, err := s.db.QueryContext(ctx, `SELECT s.ts, s.cpu, s.mem, s.cpu_req, s.mem_req, s.cpu_lim, s.mem_lim, s.cpu_cap, s.mem_cap
		FROM samples s JOIN series r ON r.id = s.series
		WHERE r.cluster = ? AND r.kind = ? AND r.namespace = ? AND r.name = ? AND r.owner_kind = ?
		AND s.tier = ? AND s.ts >= ? AND s.ts <= ? ORDER BY s.ts`,
		cluster, k.Kind, k.Namespace, k.Name, k.OwnerKind, tier.ID, from.Unix(), to.Unix())
	if err != nil {
		return tier, nil, err
	}
	defer rows.Close()
	var out []Point
	for rows.Next() {
		var p Point
		if err := rows.Scan(&p.TS, &p.CPU, &p.Mem, &p.CPUReq, &p.MemReq, &p.CPULim, &p.MemLim, &p.CPUCap, &p.MemCap); err != nil {
			return tier, nil, err
		}
		out = append(out, p)
	}
	return tier, out, rows.Err()
}

// SeriesCount é o número de séries guardadas.
func (s *Store) SeriesCount(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM series`).Scan(&n)
	return n, err
}
