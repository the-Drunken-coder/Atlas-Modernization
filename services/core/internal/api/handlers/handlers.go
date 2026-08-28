// Package handlers provides HTTP request handlers for the Atlas Core API.
package handlers

import (
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
	"github.com/the-drunken-coder/atlas/services/core/internal/admin"
	"github.com/the-drunken-coder/atlas/services/core/internal/config"
	"github.com/the-drunken-coder/atlas/services/core/internal/database"
	"github.com/the-drunken-coder/atlas/services/core/internal/feed"
	"github.com/the-drunken-coder/atlas/services/core/internal/storage"
)

// Handler provides HTTP request handling for the Atlas Core API.
type Handler struct {
	db             *database.DB
	storage        *storage.Client
	logger         zerolog.Logger
	config         *config.Config
	entityActions  *actions.EntityActions
	taskActions    *actions.TaskActions
	objectActions  *actions.ObjectActions
	checkinActions *actions.EntityCheckinActions
	queryActions   *actions.QueryActions
	feedHub        *feed.Hub
	adminAuth      *admin.Service
}

// NewHandler creates a new Handler.
func NewHandler(db *database.DB, storageClient *storage.Client, logger zerolog.Logger, cfg *config.Config) *Handler {
	return NewHandlerWithFeed(db, storageClient, logger, cfg, nil, nil)
}

// NewHandlerWithFeed creates a Handler with the feed endpoint wired to feedHub.
func NewHandlerWithFeed(db *database.DB, storageClient *storage.Client, logger zerolog.Logger, cfg *config.Config, feedHub *feed.Hub, adminAuth *admin.Service) *Handler {
	if cfg == nil {
		panic("handlers.NewHandler: config is required")
	}
	if db == nil || db.Pool == nil {
		panic("handlers.NewHandler: db with initialized pool is required")
	}
	entityActions := actions.NewEntityActions(db.Pool)
	taskActions := actions.NewTaskActions(db.Pool)

	return &Handler{
		db:             db,
		storage:        storageClient,
		logger:         logger,
		config:         cfg,
		entityActions:  entityActions,
		taskActions:    taskActions,
		objectActions:  actions.NewObjectActions(db.Pool, storageClient),
		checkinActions: actions.NewEntityCheckinActions(entityActions),
		queryActions:   actions.NewQueryActions(db.Pool),
		feedHub:        feedHub,
		adminAuth:      adminAuth,
	}
}
