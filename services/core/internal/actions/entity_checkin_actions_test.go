package actions

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestEntityCheckinPreconditions(t *testing.T) {
	pool := openActionsTestPool(t)
	entities := NewEntityActions(pool)
	checkins := NewEntityCheckinActions(entities)

	for _, empty := range []bool{false, true} {
		for _, precondition := range []string{"absent", "matching", "stale"} {
			t.Run(fmt.Sprintf("empty=%t/%s", empty, precondition), func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				entityID := fmt.Sprintf("checkin-%d", time.Now().UnixNano())
				defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, entityID, "")
				before, err := entities.Create(ctx, CreateEntityParams{EntityID: entityID, EntityType: "asset"})
				if err != nil {
					t.Fatalf("create entity: %v", err)
				}

				params := EntityCheckinParams{EntityID: entityID}
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

				result, err := checkins.CheckIn(ctx, params)
				if precondition == "stale" {
					var preconditionErr *PreconditionFailedError
					if !errors.As(err, &preconditionErr) || result != nil {
						t.Fatalf("stale check-in = %#v, %v; want no result and PreconditionFailedError", result, err)
					}
				} else if err != nil || result == nil || result.Entity == nil {
					t.Fatalf("check-in = %#v, %v; want entity", result, err)
				}

				after, err := entities.Get(ctx, entityID)
				if err != nil {
					t.Fatalf("read entity after check-in: %v", err)
				}
				if empty || precondition == "stale" {
					if after.Version != before.Version || !after.UpdatedAt.Equal(before.UpdatedAt) || !bytes.Equal(after.JSON, before.JSON) {
						t.Fatalf("rejected or empty check-in changed entity: before %#v, after %#v", before, after)
					}
				} else if after.Version <= before.Version || after.GetComponents()["status"] == nil {
					t.Fatalf("check-in did not persist status with a newer version: %#v", after)
				}
				if result != nil && (result.Entity.Version != after.Version || !bytes.Equal(result.Entity.JSON, after.JSON)) {
					t.Fatal("check-in result differs from stored entity")
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

func TestEntityCheckinMissingEntity(t *testing.T) {
	checkins := NewEntityCheckinActions(NewEntityActions(openActionsTestPool(t)))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	version := int64(1)
	for _, expectedVersion := range []*int64{nil, &version} {
		result, err := checkins.CheckIn(ctx, EntityCheckinParams{
			EntityID:        fmt.Sprintf("missing-checkin-%d", time.Now().UnixNano()),
			Components:      map[string]interface{}{"status": map[string]interface{}{"value": "online"}},
			ExpectedVersion: expectedVersion,
		})
		var notFound *NotFoundError
		if !errors.As(err, &notFound) || result != nil {
			t.Fatalf("missing entity check-in = %#v, %v; want no result and NotFoundError", result, err)
		}
	}
}
