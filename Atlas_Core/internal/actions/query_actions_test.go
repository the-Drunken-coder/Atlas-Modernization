package actions

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestCurrentChangeVersionIncludesBurnedSequenceValues(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx := context.Background()

	var burnedVersion int64
	if err := pool.QueryRow(ctx, `SELECT nextval('atlas_change_version_seq')`).Scan(&burnedVersion); err != nil {
		t.Fatalf("burn change version: %v", err)
	}

	currentVersion, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("CurrentChangeVersion: %v", err)
	}
	if currentVersion < burnedVersion {
		t.Fatalf("CurrentChangeVersion = %d, want at least burned sequence version %d", currentVersion, burnedVersion)
	}
}

func TestReadSnapshotVersionIgnoresUncommittedSequenceAllocations(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx := context.Background()

	suffix := time.Now().UTC().UnixNano()
	committedID := fmt.Sprintf("snapshot-visible-%d", suffix)
	uncommittedID := fmt.Sprintf("snapshot-hidden-%d", suffix)
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM entities WHERE entity_id = ANY($1)`, []string{committedID, uncommittedID}); err != nil {
			t.Errorf("cleanup snapshot test entities: %v", err)
		}
	})

	var committedVersion int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO entities (entity_id, type, json)
		VALUES ($1, 'asset', '{}'::jsonb)
		RETURNING version
	`, committedID).Scan(&committedVersion); err != nil {
		t.Fatalf("insert committed entity: %v", err)
	}

	reader, err := pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		t.Fatalf("begin reader transaction: %v", err)
	}
	defer func() { _ = reader.Rollback(ctx) }()

	snapshotVersion, err := readSnapshotVersion(ctx, reader)
	if err != nil {
		t.Fatalf("read initial snapshot version: %v", err)
	}
	if snapshotVersion < committedVersion {
		t.Fatalf("snapshot version = %d, want at least committed entity version %d", snapshotVersion, committedVersion)
	}

	writer, err := beginChangeTx(ctx, pool, "snapshot version regression")
	if err != nil {
		t.Fatalf("begin writer transaction: %v", err)
	}
	defer func() { _ = writer.Rollback(ctx) }()

	var allocatedVersion int64
	if err := writer.QueryRow(ctx, `
		INSERT INTO entities (entity_id, type, json)
		VALUES ($1, 'asset', '{}'::jsonb)
		RETURNING version
	`, uncommittedID).Scan(&allocatedVersion); err != nil {
		t.Fatalf("insert uncommitted entity: %v", err)
	}
	if allocatedVersion <= snapshotVersion {
		t.Fatalf("allocated version = %d, want greater than snapshot version %d", allocatedVersion, snapshotVersion)
	}

	gotVersion, err := readSnapshotVersion(ctx, reader)
	if err != nil {
		t.Fatalf("read snapshot version after uncommitted write: %v", err)
	}
	if gotVersion != snapshotVersion {
		t.Fatalf("snapshot version advanced to invisible sequence value: got %d, want %d; uncommitted version was %d", gotVersion, snapshotVersion, allocatedVersion)
	}
}
