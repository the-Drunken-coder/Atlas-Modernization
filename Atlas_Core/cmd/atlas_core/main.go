// Package main is the entry point for the Atlas Core API server.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/api/handlers"
	custommiddleware "github.com/the-drunken-coder/atlas/atlas_core/internal/api/middleware"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/database"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

func atlasCORSOptions(allowedOrigins []string) cors.Options {
	return cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "If-Match", "X-API-Key", "X-Request-ID"},
		ExposedHeaders:   []string{"ETag", "X-Has-More", "X-Next-Cursor", "X-Limit", "X-Returned-Count", "Content-Length"},
		AllowCredentials: false,
		MaxAge:           300,
	}
}

func runStorageDeletionReconciler(ctx context.Context, logger zerolog.Logger, objectActions *actions.ObjectActions, interval time.Duration, limit int) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			deleted, err := objectActions.ReconcileStorageDeletions(ctx, limit)
			if err != nil {
				logger.Warn().Err(err).Msg("Storage deletion reconciliation failed")
				continue
			}
			if deleted > 0 {
				logger.Info().Int("deleted", deleted).Msg("Reconciled queued storage deletions")
			}
		}
	}
}

func main() {
	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load configuration: %v\n", err)
		os.Exit(1)
	}

	// Configure logging
	zerolog.TimeFieldFormat = time.RFC3339
	logLevel := zerolog.InfoLevel
	switch strings.ToUpper(strings.TrimSpace(cfg.LogLevel)) {
	case "DEBUG":
		logLevel = zerolog.DebugLevel
	case "WARNING", "WARN":
		logLevel = zerolog.WarnLevel
	case "ERROR":
		logLevel = zerolog.ErrorLevel
	}
	zerolog.SetGlobalLevel(logLevel)

	logger := zerolog.New(os.Stdout).With().Timestamp().Str("service", "atlas-core").Logger()

	logger.Info().Msg("ATLAS Core API starting up...")

	apiKey := strings.TrimSpace(cfg.APIAuthKey)
	if cfg.EnableAPIAuth {
		if apiKey == "" {
			logger.Fatal().Msg("API auth is enabled but API_AUTH_KEY (or api_auth_key in settings) is empty — refusing to start without credentials")
		}
		if apiKey == "REPLACE_WITH_SECURE_KEY" {
			logger.Fatal().Msg("API auth is enabled but api_auth_key is still the example placeholder REPLACE_WITH_SECURE_KEY — set a real secret in atlas_core.settings.json or API_AUTH_KEY")
		}
	}

	// Connect to database
	db, err := database.New(cfg)
	if err != nil {
		logger.Fatal().Err(err).Msg("Failed to connect to database")
	}
	defer db.Close()

	// Ensure database tables exist
	ensureCtx, ensureCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer ensureCancel()
	if err := db.EnsureTables(ensureCtx); err != nil {
		logger.Fatal().Err(err).Msg("Failed to ensure database tables")
	}

	// Connect to storage (optional - may not be configured)
	var storageClient *storage.Client
	if cfg.MinIOSecretKey != "" {
		storageClient, err = storage.NewClient(cfg)
		if err != nil {
			logger.Warn().Err(err).Msg("Failed to initialize storage client")
		} else {
			// Ensure bucket exists
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := storageClient.EnsureBucket(ctx); err != nil {
				logger.Warn().Err(err).Msg("Failed to ensure storage bucket exists")
			}
			cancel()
			if cfg.DatabaseRecreateOnStartup {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				if err := storageClient.EmptyBucket(ctx); err != nil {
					cancel()
					logger.Fatal().Err(err).Str("bucket", storageClient.Bucket()).Msg("Failed to clear storage bucket while DATABASE_RECREATE_ON_STARTUP=true")
				}
				cancel()
				logger.Info().Str("bucket", storageClient.Bucket()).Msg("Cleared storage bucket because DATABASE_RECREATE_ON_STARTUP=true")
			}
		}
	} else {
		logger.Warn().Msg("MinIO secret key not configured, storage features disabled")
	}

	reconcilerCtx, stopReconciler := context.WithCancel(context.Background())
	defer stopReconciler()
	if storageClient != nil {
		go runStorageDeletionReconciler(
			reconcilerCtx,
			logger,
			actions.NewObjectActions(db.Pool, storageClient),
			time.Minute,
			100,
		)
	}

	// Create handler
	handler := handlers.NewHandler(db, storageClient, logger, cfg)

	// Create router
	r := chi.NewRouter()

	// Add middleware
	r.Use(middleware.ClientIPFromRemoteAddr)
	r.Use(middleware.RequestID)
	r.Use(custommiddleware.RequestLogger(logger))
	r.Use(middleware.Recoverer)
	r.Use(middleware.Compress(5))

	// Add CORS
	r.Use(cors.Handler(atlasCORSOptions(cfg.CORSOrigins)))

	// API key middleware must be registered before route handlers (chi requirement); health/readiness skip auth.
	if cfg.EnableAPIAuth {
		logger.Info().Msg("API key authentication enabled")
		r.Use(custommiddleware.APIKeyAuth(apiKey))
	} else {
		logger.Info().Msg("API key authentication disabled (set ENABLE_API_AUTH=true or enable_api_auth=true in atlas_core.settings.json)")
	}

	// Public health endpoints (no API key — middleware skips these paths)
	r.Get("/health", handler.LivenessCheck)
	r.Get("/readiness", handler.ReadinessCheck)

	// Register routes
	r.Get("/", handler.Root)

	// Entity routes
	r.Get("/entities", handler.ListEntities)
	r.Post("/entities", handler.CreateEntity)
	r.Get("/entities/{entity_id}", handler.GetEntity)
	r.Patch("/entities/{entity_id}", handler.UpdateEntity)
	r.Delete("/entities/{entity_id}", handler.DeleteEntity)
	r.Get("/entities/alias/{alias}", handler.GetEntityByAlias)
	r.Patch("/entities/{entity_id}/telemetry", handler.UpdateEntityTelemetry)
	r.Post("/entities/{entity_id}/checkin", handler.EntityCheckin)
	r.Get("/entities/{entity_id}/tasks", handler.GetTasksByEntity)
	r.Get("/entities/{entity_id}/objects", handler.GetObjectsByEntity)

	// Task routes
	r.Get("/tasks", handler.ListTasks)
	r.Post("/tasks", handler.CreateTask)
	r.Get("/tasks/{task_id}", handler.GetTask)
	r.Patch("/tasks/{task_id}", handler.UpdateTask)
	r.Delete("/tasks/{task_id}", handler.DeleteTask)
	r.Post("/tasks/{task_id}/acknowledge", handler.AcknowledgeTask)
	r.Post("/tasks/{task_id}/complete", handler.CompleteTask)
	r.Post("/tasks/{task_id}/fail", handler.FailTask)
	r.Post("/tasks/{task_id}/status", handler.TaskStatus)
	r.Get("/tasks/{task_id}/objects", handler.GetObjectsByTask)

	// Object routes
	r.Get("/objects", handler.ListObjects)
	r.Post("/objects", handler.CreateObject)
	r.Post("/objects/upload", handler.UploadObject)
	r.Get("/objects/{object_id}", handler.GetObject)
	r.Patch("/objects/{object_id}", handler.UpdateObject)
	r.Delete("/objects/{object_id}", handler.DeleteObject)
	r.Get("/objects/{object_id}/download", handler.DownloadObject)
	r.Get("/objects/{object_id}/view", handler.ViewObject)

	// Query routes
	r.Get("/queries/full", handler.GetFullDataset)
	r.Get("/queries/changed-since", handler.GetChangedSince)

	// Create server
	server := &http.Server{
		Addr:              ":" + cfg.ServerPort,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Start server in goroutine
	go func() {
		logger.Info().Str("port", cfg.ServerPort).Msg("Starting HTTP server")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal().Err(err).Msg("HTTP server error")
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info().Msg("ATLAS Core API shutting down...")
	stopReconciler()

	// Graceful shutdown with timeout
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error().Err(err).Msg("Server shutdown error")
	}

	logger.Info().Msg("ATLAS Core API shutdown complete")
}
