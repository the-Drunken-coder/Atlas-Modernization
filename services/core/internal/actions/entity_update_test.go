package actions

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestEntityUpdatePreconditions(t *testing.T) {
	pool := openActionsTestPool(t)
	entities := NewEntityActions(pool)

	for _, empty := range []bool{false, true} {
		for _, precondition := range []string{"absent", "matching", "stale"} {
			t.Run(fmt.Sprintf("empty=%t/%s", empty, precondition), func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				entityID := fmt.Sprintf("update-%d", time.Now().UnixNano())
				before, err := entities.Create(ctx, CreateEntityParams{EntityID: entityID, EntityType: "asset"})
				if err != nil {
					t.Fatalf("create entity: %v", err)
				}

				params := UpdateEntityParams{}
				if !empty {
					params.Components = map[string]interface{}{"status": map[string]interface{}{"value": "online"}}
				}
				version := before.Version
				if precondition != "absent" {
					if precondition == "stale" {
						version--
					}
					params.ExpectedVersion = &version
				}

				result, err := entities.Update(ctx, entityID, params)
				if precondition == "stale" {
					var preconditionErr *PreconditionFailedError
					if !errors.As(err, &preconditionErr) || result != nil {
						t.Fatalf("stale update = %#v, %v; want no result and PreconditionFailedError", result, err)
					}
				} else if err != nil || result == nil {
					t.Fatalf("update = %#v, %v; want entity", result, err)
				}

				after, err := entities.Get(ctx, entityID)
				if err != nil {
					t.Fatalf("read entity after update: %v", err)
				}
				if empty || precondition == "stale" {
					if after.Version != before.Version || !after.UpdatedAt.Equal(before.UpdatedAt) || !bytes.Equal(after.JSON, before.JSON) {
						t.Fatalf("rejected or empty update changed entity: before %#v, after %#v", before, after)
					}
				} else if after.Version <= before.Version || after.GetComponents()["status"] == nil {
					t.Fatalf("update did not persist status with a newer version: %#v", after)
				}
				if result != nil && (result.Version != after.Version || !bytes.Equal(result.JSON, after.JSON)) {
					t.Fatal("update result differs from stored entity")
				}

				var eventCount int
				if err := pool.QueryRow(ctx, `SELECT count(*) FROM atlas_change_events WHERE event->>'resource_type' = 'entity' AND event->>'id' = $1`, entityID).Scan(&eventCount); err != nil {
					t.Fatalf("count entity changes: %v", err)
				}
				wantEvents := 1
				if !empty && precondition != "stale" {
					wantEvents++
				}
				if eventCount != wantEvents {
					t.Fatalf("entity change count = %d, want %d", eventCount, wantEvents)
				}
			})
		}
	}
}

func TestEntityUpdateMissingEntity(t *testing.T) {
	entities := NewEntityActions(openActionsTestPool(t))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	version := int64(1)
	for _, expectedVersion := range []*int64{nil, &version} {
		result, err := entities.Update(ctx, fmt.Sprintf("missing-update-%d", time.Now().UnixNano()), UpdateEntityParams{
			Components:      map[string]interface{}{"status": map[string]interface{}{"value": "online"}},
			ExpectedVersion: expectedVersion,
		})
		var notFound *NotFoundError
		if !errors.As(err, &notFound) || result != nil {
			t.Fatalf("missing entity update = %#v, %v; want no result and NotFoundError", result, err)
		}
	}
}
