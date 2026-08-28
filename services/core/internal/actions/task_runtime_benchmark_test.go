package actions

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// BenchmarkRuntimeRestartFencing measures the complete runtime registration
// drain. Fixture creation and cleanup stay outside the timed section.
func BenchmarkRuntimeRestartFencing(b *testing.B) {
	pool := openActionsTestPool(b)
	for _, taskCount := range []int{100, 1_000, 10_000} {
		b.Run(fmt.Sprintf("tasks_%d", taskCount), func(b *testing.B) {
			for iteration := 0; iteration < b.N; iteration++ {
				b.StopTimer()
				stamp := time.Now().UnixNano()
				assetID := fmt.Sprintf("restart-bench-%d-%d", taskCount, stamp)
				oldRuntimeID := fmt.Sprintf("runtime-old-%d", stamp)
				newRuntimeID := fmt.Sprintf("runtime-new-%d", stamp)
				taskPrefix := fmt.Sprintf("bench-%d-%d", taskCount, stamp)
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)

				if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{
					EntityID:   assetID,
					EntityType: "asset",
				}); err != nil {
					cancel()
					b.Fatalf("create benchmark Asset: %v", err)
				}
				tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(b))
				if err := tasks.BeginRuntimeRegistration(ctx, assetID, oldRuntimeID); err != nil {
					cancel()
					b.Fatalf("register old benchmark runtime: %v", err)
				}
				if _, err := pool.Exec(ctx, `
					INSERT INTO tasks (
						task_id, asset_id, command, input, status, idempotency_key,
						runtime_id, created_at, updated_at, version
					)
					SELECT
						$1 || '-' || sequence,
						$2,
						'fixture.queued',
						'{}'::jsonb,
						'pending',
						$1 || '-attempt-' || sequence,
						$3,
						clock_timestamp(),
						clock_timestamp(),
						1
					FROM generate_series(1, $4) AS sequence
				`, taskPrefix, assetID, oldRuntimeID, taskCount); err != nil {
					cancel()
					b.Fatalf("seed %d benchmark Tasks: %v", taskCount, err)
				}

				b.StartTimer()
				err := tasks.BeginRuntimeRegistration(ctx, assetID, newRuntimeID)
				b.StopTimer()
				if err != nil {
					cancel()
					b.Fatalf("restart runtime with %d Tasks: %v", taskCount, err)
				}

				var failed int
				if err := pool.QueryRow(ctx, `
					SELECT COUNT(*) FROM tasks
					WHERE asset_id = $1 AND status = 'failed'
						AND failure->>'code' = 'asset_restarted'
				`, assetID).Scan(&failed); err != nil {
					cancel()
					b.Fatalf("count fenced benchmark Tasks: %v", err)
				}
				if failed != taskCount {
					cancel()
					b.Fatalf("fenced benchmark Tasks = %d, want %d", failed, taskCount)
				}
				cleanupFinalBlobValidationRows(ctx, b, pool, assetID, "")
				cancel()
			}
		})
	}
}
