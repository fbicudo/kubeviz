// Package store guarda os dados do KubeViz que precisam sobreviver a um
// reinício: por enquanto, o histórico de métricas do coletor embutido.
//
// Usa SQLite (modernc.org/sqlite, Go puro: o binário continua sem CGO), num
// único arquivo com WAL.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Store é o banco do KubeViz.
type Store struct {
	db   *sql.DB
	path string

	mu     sync.Mutex
	series map[seriesKey]int64
}

// Open abre (ou cria) o banco em path e aplica as migrações.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// Um único escritor: o SQLite serializa as escritas de qualquer forma.
	db.SetMaxOpenConns(1)
	s := &Store{db: db, path: path, series: map[seriesKey]int64{}}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, fmt.Errorf("preparando o banco %s: %w", path, err)
	}
	return s, nil
}

// Close fecha o banco.
func (s *Store) Close() error { return s.db.Close() }

// Path é o arquivo do banco.
func (s *Store) Path() string { return s.path }

// Size é o tamanho do banco em disco (arquivo principal e WAL).
func (s *Store) Size() int64 {
	var total int64
	for _, p := range []string{s.path, s.path + "-wal"} {
		if info, err := os.Stat(p); err == nil {
			total += info.Size()
		}
	}
	return total
}

var migrations = []string{
	// 1: histórico de métricas.
	`CREATE TABLE series (
		id INTEGER PRIMARY KEY,
		cluster TEXT NOT NULL,
		kind TEXT NOT NULL,
		namespace TEXT NOT NULL DEFAULT '',
		name TEXT NOT NULL DEFAULT '',
		owner_kind TEXT NOT NULL DEFAULT '',
		UNIQUE (cluster, kind, namespace, name, owner_kind)
	);
	CREATE TABLE samples (
		series INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
		tier INTEGER NOT NULL,
		ts INTEGER NOT NULL,
		cpu REAL NOT NULL, mem REAL NOT NULL,
		cpu_req REAL NOT NULL, mem_req REAL NOT NULL,
		cpu_lim REAL NOT NULL, mem_lim REAL NOT NULL,
		cpu_cap REAL NOT NULL, mem_cap REAL NOT NULL,
		PRIMARY KEY (series, tier, ts)
	) WITHOUT ROWID;
	CREATE INDEX samples_tier_ts ON samples (tier, ts);
	CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
}

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return err
	}
	var version int
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migração %d: %w", i+1, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_version (version) VALUES (?)`, i+1); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) meta(ctx context.Context, key string) (int64, error) {
	var v int64
	err := s.db.QueryRowContext(ctx, `SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return v, err
}

func setMeta(ctx context.Context, tx *sql.Tx, key string, v int64) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, v)
	return err
}

// now é substituível nos testes.
var now = time.Now
