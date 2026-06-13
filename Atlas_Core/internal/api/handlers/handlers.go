// Package handlers provides HTTP request handlers for the Atlas Core API.
package handlers

import (
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/database"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
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
	feedHub       *feed.Hub
}

// NewHandler creates a new Handler.
func NewHandler(db *database.DB, storageClient *storage.Client, logger zerolog.Logger, cfg *config.Config) *Handler {
	return NewHandlerWithFeed(db, storageClient, logger, cfg, nil)
}

// NewHandlerWithFeed creates a new Handler and wires committed writes into feedHub.
func NewHandlerWithFeed(db *database.DB, storageClient *storage.Client, logger zerolog.Logger, cfg *config.Config, feedHub *feed.Hub) *Handler {
	if cfg == nil {
		panic("handlers.NewHandler: config is required")
	}
	if db == nil || db.Pool == nil {
		panic("handlers.NewHandler: db with initialized pool is required")
	}
	changeSink := feed.NewAsyncChangeSink(feedHub, feed.AsyncChangeSinkOptions{})

	return &Handler{
		db:            db,
		storage:       storageClient,
		logger:        logger,
		config:        cfg,
		entityActions: actions.NewEntityActionsWithChangeSink(db.Pool, changeSink),
		taskActions:   actions.NewTaskActionsWithChangeSink(db.Pool, changeSink),
		objectActions: actions.NewObjectActionsWithChangeSink(db.Pool, storageClient, changeSink),
		queryActions:  actions.NewQueryActions(db.Pool),
		feedHub:       feedHub,
	}
}
