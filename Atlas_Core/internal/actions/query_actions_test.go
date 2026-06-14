package actions

import (
	"context"
	"testing"
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
