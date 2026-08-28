package feed

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
)

const changeDispatchBatchSize = 32
const changeDispatchReadTimeout = 30 * time.Second
const changeDispatchInitialRetry = time.Second
const changeDispatchMaxRetry = 30 * time.Second
const changePruneInterval = time.Hour

// Dispatcher tails the durable change log in commit order. LISTEN/NOTIFY is
// only a wake-up mechanism; every delivered payload comes from PostgreSQL.
type Dispatcher struct {
	pool       *pgxpool.Pool
	hub        *Hub
	cursor     int64
	lastPruned time.Time
}

func NewDispatcher(pool *pgxpool.Pool, hub *Hub, startAfterVersion int64) *Dispatcher {
	return &Dispatcher{pool: pool, hub: hub, cursor: startAfterVersion}
}

func (d *Dispatcher) Run(ctx context.Context) {
	retryDelay := changeDispatchInitialRetry
	for ctx.Err() == nil {
		connectedAt := time.Now()
		err := d.runConnection(ctx)
		if ctx.Err() != nil || errors.Is(err, context.Canceled) {
			return
		}
		if time.Since(connectedAt) >= changeDispatchMaxRetry {
			retryDelay = changeDispatchInitialRetry
		}
		logger := log.Warn()
		if retryDelay == changeDispatchInitialRetry {
			logger = log.Error()
		}
		logger.Err(err).Int64("cursor", d.cursor).Dur("retry_in", retryDelay).Msg("Atlas change dispatcher disconnected")

		timer := time.NewTimer(retryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if retryDelay < changeDispatchMaxRetry {
			retryDelay *= 2
			if retryDelay > changeDispatchMaxRetry {
				retryDelay = changeDispatchMaxRetry
			}
		}
	}
}

func (d *Dispatcher) runConnection(ctx context.Context) error {
	conn, err := pgx.ConnectConfig(ctx, d.pool.Config().ConnConfig.Copy())
	if err != nil {
		return fmt.Errorf("connect change listener: %w", err)
	}
	defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()
	if _, err := conn.Exec(ctx, `LISTEN atlas_change_events`); err != nil {
		return fmt.Errorf("listen for change events: %w", err)
	}

	for {
		if err := d.drain(ctx, conn); err != nil {
			return err
		}
		if d.lastPruned.IsZero() || time.Since(d.lastPruned) >= changePruneInterval {
			if _, err := actions.PruneChangeRecords(ctx, d.pool, time.Now().Add(-actions.ChangeRecordRetention)); err != nil {
				return err
			}
			d.lastPruned = time.Now()
		}
		waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		_, err := conn.WaitForNotification(waitCtx)
		cancel()
		if err == nil || errors.Is(err, context.DeadlineExceeded) {
			continue
		}
		return fmt.Errorf("wait for change notification: %w", err)
	}
}

func (d *Dispatcher) drain(ctx context.Context, conn *pgx.Conn) error {
	for {
		readCtx, cancel := context.WithTimeout(ctx, changeDispatchReadTimeout)
		var upperVersion int64
		if err := conn.QueryRow(readCtx, `SELECT version FROM atlas_change_clock WHERE singleton`).Scan(&upperVersion); err != nil {
			cancel()
			return fmt.Errorf("read change dispatch watermark: %w", err)
		}
		records, hasMore, err := actions.ReadChangeRecords(readCtx, conn, d.cursor, upperVersion, changeDispatchBatchSize)
		cancel()
		if err != nil {
			return err
		}
		for _, record := range records {
			d.hub.Publish(RoutedEvent{
				Event:       record.Event,
				TaskAssetID: record.TaskAssetID,
			})
			d.cursor = record.Event.Version
		}
		if !hasMore {
			return nil
		}
	}
}
