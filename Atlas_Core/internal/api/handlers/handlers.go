// Package handlers provides HTTP request handlers for the Atlas Core API.
package handlers

import (
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/entityactions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/objectactions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/syncactions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/taskactions"
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
	entityActions *entityactions.Actions
	taskActions   *taskactions.Actions
	objectActions *objectactions.Actions
	queryActions  *syncactions.Actions
}

// NewHandler creates a new Handler.
func NewHandler(db *database.DB, storageClient *storage.Client, logger zerolog.Logger, cfg *config.Config) *Handler {
	if cfg == nil {
		panic("handlers.NewHandler: config is required")
	}
	if db == nil || db.Pool == nil {
		panic("handlers.NewHandler: db with initialized pool is required")
	}

	return &Handler{
		db:            db,
		storage:       storageClient,
		logger:        logger,
		config:        cfg,
		entityActions: entityactions.New(db.Pool),
		taskActions:   taskactions.New(db.Pool),
		objectActions: objectactions.New(db.Pool, storageClient),
		queryActions:  syncactions.New(db.Pool),
	}
}
