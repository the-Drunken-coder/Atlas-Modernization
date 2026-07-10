package actions

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func TestGetFullDatasetByteBudgetPreservesCursorContinuation(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	prefix := fmt.Sprintf("zzzz-full-byte-page-%d", time.Now().UTC().UnixNano())
	ids := make([]string, 10)
	for i := range ids {
		ids[i] = fmt.Sprintf("%s-%02d", prefix, i)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM entities WHERE entity_id = ANY($1)`, ids); err != nil {
			t.Errorf("cleanup byte-budget entities: %v", err)
		}
	})

	payload := strings.Repeat("x", 950*1024)
	for _, id := range ids {
		if _, err := pool.Exec(ctx, `
			INSERT INTO entities (entity_id, type, json)
			VALUES ($1, 'asset', jsonb_build_object('payload', $2::text))
		`, id, payload); err != nil {
			t.Fatalf("insert byte-budget entity %q: %v", id, err)
		}
	}

	actions := NewQueryActions(pool)
	page, err := actions.GetFullDataset(ctx, &FullDatasetLimits{EntityLimit: MaxFullQueryLimit})
	if err != nil {
		t.Fatalf("GetFullDataset first page: %v", err)
	}
	if !page.HasMoreEntities || page.NextEntityCursor == "" {
		t.Fatalf("first page hasMore=%v cursor=%q, want byte-truncated continuation", page.HasMoreEntities, page.NextEntityCursor)
	}

	seen := make(map[string]struct{}, len(ids))
	collectTestEntities := func(entities []*models.Entity) {
		for _, entity := range entities {
			if !strings.HasPrefix(entity.EntityID, prefix) {
				continue
			}
			if _, duplicate := seen[entity.EntityID]; duplicate {
				t.Fatalf("entity %q repeated across byte-limited pages", entity.EntityID)
			}
			seen[entity.EntityID] = struct{}{}
		}
	}
	collectTestEntities(page.Entities)
	if len(seen) == 0 || len(seen) == len(ids) {
		t.Fatalf("first page returned %d/%d byte-budget fixtures, want a non-empty short page", len(seen), len(ids))
	}

	cursor := page.NextEntityCursor
	for continuation := 0; len(seen) < len(ids) && continuation < 3; continuation++ {
		if cursor == "" {
			t.Fatalf("continuation %d has no cursor with %d/%d fixtures returned", continuation+1, len(seen), len(ids))
		}
		page, err = actions.GetFullDataset(ctx, &FullDatasetLimits{
			EntityLimit:  MaxFullQueryLimit,
			EntityCursor: &cursor,
		})
		if err != nil {
			t.Fatalf("GetFullDataset continuation %d: %v", continuation+1, err)
		}
		collectTestEntities(page.Entities)
		cursor = page.NextEntityCursor
		if !page.HasMoreEntities && len(seen) < len(ids) {
			break
		}
	}
	if len(seen) != len(ids) {
		t.Fatalf("byte-limited continuation returned %d/%d fixtures; cursor skipped rows", len(seen), len(ids))
	}
}

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
