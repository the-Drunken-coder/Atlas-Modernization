package feed

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
)

const changeDispatchBatchSize = 1000

// Dispatcher tails the durable change log in commit order. LISTEN/NOTIFY is
// only a wake-up mechanism; every delivered payload comes from PostgreSQL.
type Dispatcher struct {
	pool   *pgxpool.Pool
	hub    *Hub
	cursor int64
}

func NewDispatcher(pool *pgxpool.Pool, hub *Hub, startAfterVersion int64) *Dispatcher {
	return &Dispatcher{pool: pool, hub: hub, cursor: startAfterVersion}
}

func (d *Dispatcher) Run(ctx context.Context) {
	for ctx.Err() == nil {
		if err := d.runConnection(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Error().Err(err).Int64("cursor", d.cursor).Msg("Atlas change dispatcher disconnected; retrying")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (d *Dispatcher) runConnection(ctx context.Context) error {
	conn, err := d.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire change listener connection: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `LISTEN atlas_change_events`); err != nil {
		return fmt.Errorf("listen for change events: %w", err)
	}

	for {
		if err := d.drain(ctx, conn); err != nil {
			return err
		}
		waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		_, err := conn.Conn().WaitForNotification(waitCtx)
		cancel()
		if err == nil || errors.Is(err, context.DeadlineExceeded) {
			continue
		}
		return fmt.Errorf("wait for change notification: %w", err)
	}
}

func (d *Dispatcher) drain(ctx context.Context, conn *pgxpool.Conn) error {
	for {
		var upperVersion int64
		if err := conn.QueryRow(ctx, `SELECT version FROM atlas_change_clock WHERE singleton`).Scan(&upperVersion); err != nil {
			return fmt.Errorf("read change dispatch watermark: %w", err)
		}
		records, hasMore, err := actions.ReadChangeRecords(ctx, conn, d.cursor, upperVersion, changeDispatchBatchSize)
		if err != nil {
			return err
		}
		for _, record := range records {
			d.hub.Publish(RoutedEvent{
				Event:              record.Event,
				BeforeTaskEntityID: record.BeforeTaskEntityID,
				AfterTaskEntityID:  record.AfterTaskEntityID,
			})
			d.cursor = record.Event.Version
		}
		if !hasMore {
			return nil
		}
	}
}
