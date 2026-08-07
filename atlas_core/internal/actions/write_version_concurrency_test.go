package actions

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCreateDeleteAndUniqueValueRacesDoNotDeadlock(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	suffix := time.Now().UTC().UnixNano()
	entityActions := NewEntityActions(pool)
	taskActions := NewTaskActions(pool)
	objectActions := NewObjectActions(pool, nil)
	entityID := fmt.Sprintf("race-entity-%d", suffix)
	taskID := fmt.Sprintf("race-task-%d", suffix)
	objectID := fmt.Sprintf("race-object-%d", suffix)
	parentID := fmt.Sprintf("race-parent-%d", suffix)
	aliasOwnerID := fmt.Sprintf("race-alias-owner-%d", suffix)
	aliasCreateID := fmt.Sprintf("race-alias-create-%d", suffix)
	pathOwnerID := fmt.Sprintf("race-path-owner-%d", suffix)
	pathCreateID := fmt.Sprintf("race-path-create-%d", suffix)
	ids := []string{entityID, taskID, objectID, parentID, aliasOwnerID, aliasCreateID, pathOwnerID, pathCreateID}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tasks WHERE task_id = $1`, taskID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM entities WHERE entity_id = ANY($1)`, []string{entityID, parentID, aliasOwnerID, aliasCreateID})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM objects WHERE object_id = ANY($1)`, []string{objectID, pathOwnerID, pathCreateID})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM object_deletion_fences WHERE object_id = ANY($1)`, []string{objectID, pathOwnerID, pathCreateID})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM atlas_change_events WHERE event->>'id' = ANY($1)`, ids)
	})

	if _, err := entityActions.Create(ctx, CreateEntityParams{EntityID: entityID, EntityType: "asset"}); err != nil {
		t.Fatalf("create entity race fixture: %v", err)
	}
	runMutationRace(t, "entity create versus delete", func() error {
		_, err := entityActions.Create(ctx, CreateEntityParams{EntityID: entityID, EntityType: "asset"})
		return err
	}, func() error { return entityActions.Delete(ctx, entityID) })

	if _, err := entityActions.Create(ctx, CreateEntityParams{EntityID: parentID, EntityType: "asset"}); err != nil {
		t.Fatalf("create task parent: %v", err)
	}
	if _, err := taskActions.Create(ctx, CreateTaskParams{TaskID: taskID, EntityID: &parentID}); err != nil {
		t.Fatalf("create task race fixture: %v", err)
	}
	runMutationRace(t, "task create versus delete", func() error {
		_, err := taskActions.Create(ctx, CreateTaskParams{TaskID: taskID, EntityID: &parentID})
		return err
	}, func() error { return taskActions.Delete(ctx, taskID) })

	if _, err := objectActions.Create(ctx, CreateObjectParams{ObjectID: objectID}); err != nil {
		t.Fatalf("create object race fixture: %v", err)
	}
	runMutationRace(t, "object create versus delete", func() error {
		_, err := objectActions.Create(ctx, CreateObjectParams{ObjectID: objectID})
		return err
	}, func() error { return objectActions.Delete(ctx, objectID) })

	if _, err := entityActions.Create(ctx, CreateEntityParams{EntityID: aliasOwnerID, EntityType: "asset"}); err != nil {
		t.Fatalf("create alias owner: %v", err)
	}
	alias := fmt.Sprintf("race-alias-%d", suffix)
	runMutationRace(t, "entity create versus alias update", func() error {
		_, err := entityActions.Create(ctx, CreateEntityParams{EntityID: aliasCreateID, EntityType: "asset", Alias: &alias})
		return err
	}, func() error {
		_, err := entityActions.Update(ctx, aliasOwnerID, UpdateEntityParams{Alias: &alias})
		return err
	})

	if _, err := objectActions.Create(ctx, CreateObjectParams{ObjectID: pathOwnerID}); err != nil {
		t.Fatalf("create path owner: %v", err)
	}
	path := fmt.Sprintf("objects/race-%d/blob", suffix)
	runMutationRace(t, "object create versus path update", func() error {
		_, err := objectActions.Create(ctx, CreateObjectParams{ObjectID: pathCreateID, Path: &path})
		return err
	}, func() error {
		_, err := objectActions.Update(ctx, pathOwnerID, UpdateObjectParams{Path: &path})
		return err
	})
}

func runMutationRace(t *testing.T, name string, first, second func() error) {
	t.Helper()
	t.Run(name, func(t *testing.T) {
		start := make(chan struct{})
		results := make(chan error, 2)
		for _, mutation := range []func() error{first, second} {
			go func() {
				<-start
				results <- mutation()
			}()
		}
		close(start)
		for index := 0; index < 2; index++ {
			select {
			case err := <-results:
				if err == nil {
					continue
				}
				var conflict *ConflictError
				if !errors.As(err, &conflict) {
					t.Fatalf("race returned non-domain error: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("race did not complete; possible deadlock")
			}
		}
	})
}

func TestVersionedMutationsWaitForClockBeforeResourceRows(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	suffix := time.Now().UTC().UnixNano()
	entityID := fmt.Sprintf("lock-entity-%d", suffix)
	taskID := fmt.Sprintf("lock-task-%d", suffix)
	objectID := fmt.Sprintf("lock-object-%d", suffix)
	createdEntityID := fmt.Sprintf("lock-create-%d", suffix)
	entityActions := NewEntityActions(pool)
	taskActions := NewTaskActions(pool)
	objectActions := NewObjectActions(pool, nil)
	if _, err := entityActions.Create(ctx, CreateEntityParams{EntityID: entityID, EntityType: "asset"}); err != nil {
		t.Fatalf("create entity: %v", err)
	}
	if _, err := taskActions.Create(ctx, CreateTaskParams{TaskID: taskID, EntityID: &entityID}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	if _, err := objectActions.Create(ctx, CreateObjectParams{ObjectID: objectID}); err != nil {
		t.Fatalf("create object: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		for _, id := range []string{taskID} {
			_, _ = pool.Exec(cleanupCtx, `DELETE FROM tasks WHERE task_id = $1`, id)
		}
		for _, id := range []string{entityID, createdEntityID} {
			_, _ = pool.Exec(cleanupCtx, `DELETE FROM entities WHERE entity_id = $1`, id)
		}
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM objects WHERE object_id = $1`, objectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM object_deletion_fences WHERE object_id = $1`, objectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM atlas_change_events WHERE event->>'id' = ANY($1)`, []string{entityID, createdEntityID, taskID, objectID})
	})

	type lockedResource struct {
		query string
		id    string
	}
	alias := fmt.Sprintf("lock-order-%d", suffix)
	cases := []struct {
		name      string
		mutations []func() error
		resources []lockedResource
	}{
		{
			name: "alias-changing entity update",
			mutations: []func() error{func() error {
				_, err := entityActions.Update(ctx, entityID, UpdateEntityParams{Alias: &alias})
				return err
			}},
			resources: []lockedResource{{query: `SELECT 1 FROM entities WHERE entity_id = $1 FOR UPDATE NOWAIT`, id: entityID}},
		},
		{
			name:      "object delete",
			mutations: []func() error{func() error { return objectActions.Delete(ctx, objectID) }},
			resources: []lockedResource{{query: `SELECT 1 FROM objects WHERE object_id = $1 FOR UPDATE NOWAIT`, id: objectID}},
		},
		{
			name: "entity delete and concurrent task mutation",
			mutations: []func() error{
				func() error { return entityActions.Delete(ctx, entityID) },
				func() error {
					_, err := taskActions.Update(ctx, taskID, UpdateTaskParams{Extra: map[string]interface{}{"lock_order": true}})
					return err
				},
			},
			resources: []lockedResource{
				{query: `SELECT 1 FROM entities WHERE entity_id = $1 FOR UPDATE NOWAIT`, id: entityID},
				{query: `SELECT 1 FROM tasks WHERE task_id = $1 FOR UPDATE NOWAIT`, id: taskID},
			},
		},
		{
			name: "entity create",
			mutations: []func() error{func() error {
				_, err := entityActions.Create(ctx, CreateEntityParams{EntityID: createdEntityID, EntityType: "asset"})
				return err
			}},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			blocker, err := pool.Begin(ctx)
			if err != nil {
				t.Fatalf("begin clock blocker: %v", err)
			}
			defer func() { _ = blocker.Rollback(context.Background()) }()
			if _, err := blocker.Exec(ctx, `SELECT version FROM atlas_change_clock WHERE singleton FOR UPDATE`); err != nil {
				t.Fatalf("lock change clock: %v", err)
			}
			results := make(chan error, len(testCase.mutations))
			for _, mutation := range testCase.mutations {
				go func() { results <- mutation() }()
			}
			waitForClockWaiters(ctx, t, pool, len(testCase.mutations))

			checker, err := pool.Begin(ctx)
			if err != nil {
				t.Fatalf("begin resource lock checker: %v", err)
			}
			for _, resource := range testCase.resources {
				var one int
				if err := checker.QueryRow(ctx, resource.query, resource.id).Scan(&one); err != nil {
					_ = checker.Rollback(ctx)
					t.Fatalf("mutation locked a resource before the change clock: %v", err)
				}
			}
			if err := checker.Rollback(ctx); err != nil {
				t.Fatalf("release resource lock checker: %v", err)
			}
			if err := blocker.Rollback(ctx); err != nil {
				t.Fatalf("release change clock: %v", err)
			}
			for range testCase.mutations {
				select {
				case err := <-results:
					if err != nil {
						t.Fatalf("versioned mutation failed after clock release: %v", err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("versioned mutation did not finish after clock release")
				}
			}
		})
	}
}

func waitForClockWaiters(ctx context.Context, t *testing.T, pool *pgxpool.Pool, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var count int
		if err := pool.QueryRow(ctx, `
			SELECT COUNT(*)
			FROM pg_stat_activity
			WHERE wait_event_type = 'Lock'
				AND query ILIKE '%atlas_change_clock%FOR UPDATE%'
		`).Scan(&count); err != nil {
			t.Fatalf("count change-clock waiters: %v", err)
		}
		if count >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("change-clock waiters = %d, want %d", count, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
