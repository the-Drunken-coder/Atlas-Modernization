// Package handlers provides HTTP request handlers for the Atlas Core API.
package handlers

import (
	"time"

	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/database"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

// Handler provides HTTP request handling for the Atlas Core API.
type Handler struct {
	db            *database.DB
	storage       *storage.Client
	logger        zerolog.Logger
	config        *config.Config
	entityActions *actions.EntityActions
	taskActions   *actions.TaskActions
	objectActions *actions.ObjectActions
	queryActions  *actions.QueryActions
}

// NewHandler creates a new Handler.
func NewHandler(db *database.DB, storageClient *storage.Client, logger zerolog.Logger, cfg *config.Config) *Handler {
	return &Handler{
		db:            db,
		storage:       storageClient,
		logger:        logger,
		config:        cfg,
		entityActions: actions.NewEntityActions(db.Pool),
		taskActions:   actions.NewTaskActions(db.Pool),
		objectActions: actions.NewObjectActions(db.Pool, storageClient),
		queryActions:  actions.NewQueryActions(db.Pool, time.Duration(cfg.ChangedSinceSafetyLagMS)*time.Millisecond),
	}
}
