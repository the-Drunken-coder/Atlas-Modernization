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

func TestFullDatasetKeepsInitialVersionAcrossInterleavedContinuationUpdates(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	prefix := fmt.Sprintf("full-watermark-%d-", time.Now().UTC().UnixNano())
	firstID := prefix + "z"
	secondID := prefix + "a"
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM entities WHERE entity_id = ANY($1)`, []string{firstID, secondID}); err != nil {
			t.Errorf("cleanup full dataset watermark entities: %v", err)
		}
	})

	var createdAt time.Time
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&createdAt); err != nil {
		t.Fatalf("read fixture timestamp: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO entities (entity_id, type, json, created_at, updated_at)
		VALUES
			($1, 'asset', '{}'::jsonb, $3, $3),
			($2, 'asset', '{}'::jsonb, $3, $3)
	`, firstID, secondID, createdAt); err != nil {
		t.Fatalf("insert full dataset watermark fixtures: %v", err)
	}

	queryActions := NewQueryActions(pool)
	firstPage, err := queryActions.GetFullDataset(ctx, &FullDatasetLimits{EntityLimit: 1, TaskLimit: 1, ObjectLimit: 1})
	if err != nil {
		t.Fatalf("GetFullDataset first page: %v", err)
	}
	if len(firstPage.Entities) != 1 || firstPage.Entities[0].EntityID != firstID {
		t.Fatalf("first page entities = %#v, want only %q", firstPage.Entities, firstID)
	}
	if firstPage.Version <= 0 || !firstPage.HasMoreEntities || firstPage.NextEntityCursor == "" {
		t.Fatalf("first page watermark/pagination = version %d hasMore %v cursor %q", firstPage.Version, firstPage.HasMoreEntities, firstPage.NextEntityCursor)
	}
	baseline := firstPage.Version

	entityActions := NewEntityActions(pool)
	updatedFirst, err := entityActions.Update(ctx, firstID, UpdateEntityParams{Extra: map[string]interface{}{"hydration_update": "first-page"}})
	if err != nil {
		t.Fatalf("update first-page entity: %v", err)
	}
	updatedSecond, err := entityActions.Update(ctx, secondID, UpdateEntityParams{Extra: map[string]interface{}{"hydration_update": "later-page"}})
	if err != nil {
		t.Fatalf("update later-page entity: %v", err)
	}
	if updatedFirst.Version <= baseline || updatedSecond.Version <= updatedFirst.Version {
		t.Fatalf("interleaved versions = baseline %d first %d second %d, want baseline < first < second", baseline, updatedFirst.Version, updatedSecond.Version)
	}

	cursor := firstPage.NextEntityCursor
	secondPage, err := queryActions.GetFullDataset(ctx, &FullDatasetLimits{EntityLimit: 1, EntityCursor: &cursor})
	if err != nil {
		t.Fatalf("GetFullDataset continuation: %v", err)
	}
	if secondPage.Version != baseline {
		t.Fatalf("continuation version = %d, want initial baseline %d", secondPage.Version, baseline)
	}
	if len(secondPage.Entities) != 1 || secondPage.Entities[0].EntityID != secondID || secondPage.Entities[0].Version != updatedSecond.Version {
		t.Fatalf("continuation entities = %#v, want later-page entity %q at version %d", secondPage.Entities, secondID, updatedSecond.Version)
	}

	changed, err := queryActions.GetDataChangedSince(ctx, baseline, 50, nil)
	if err != nil {
		t.Fatalf("GetDataChangedSince from hydration baseline: %v", err)
	}
	changedVersions := make(map[string]int64, len(changed.Entities))
	for _, entity := range changed.Entities {
		changedVersions[entity.EntityID] = entity.Version
	}
	if changedVersions[firstID] != updatedFirst.Version || changedVersions[secondID] != updatedSecond.Version {
		t.Fatalf("changed-since versions = %#v, want %q=%d and %q=%d", changedVersions, firstID, updatedFirst.Version, secondID, updatedSecond.Version)
	}
}
