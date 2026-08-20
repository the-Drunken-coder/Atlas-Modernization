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
	"github.com/the-drunken-coder/atlas/atlas_core/internal/admin"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/api/handlers"
	custommiddleware "github.com/the-drunken-coder/atlas/atlas_core/internal/api/middleware"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/database"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

const objectTransferIdleTimeout = 30 * time.Second

func atlasCORSOptions(allowedOrigins []string, allowedOriginPatterns []string) cors.Options {
	return cors.Options{
		AllowedMethods:   []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "Idempotency-Key", "Atlas-Runtime-ID", "If-Match", "If-None-Match", "X-API-Key", "X-Request-ID"},
		ExposedHeaders:   []string{"ETag", "X-Has-More", "X-Next-Cursor", "X-Limit", "X-Returned-Count", "Content-Length"},
		AllowCredentials: true,
		AllowOriginFunc: func(r *http.Request, origin string) bool {
			return custommiddleware.TrustedOriginWithPatterns(origin, allowedOrigins, allowedOriginPatterns)
		},
		MaxAge: 300,
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

func initializeStorage(ctx context.Context, cfg *config.Config) (*storage.Client, error) {
	client, err := storage.NewClient(cfg)
	if err != nil {
		if cfg.DatabaseRecreateOnStartup {
			return nil, nil
		}
		return nil, fmt.Errorf("initialize durable storage client: %w", err)
	}
	if cfg.DatabaseRecreateOnStartup {
		if err := client.EnsureBucket(ctx); err != nil {
			return nil, fmt.Errorf("ensure disposable storage bucket exists: %w", err)
		}
		if err := client.EmptyBucket(ctx); err != nil {
			return nil, fmt.Errorf("clear disposable storage bucket: %w", err)
		}
		return client, nil
	}
	exists, err := client.BucketExists(ctx)
	if err != nil {
		return nil, fmt.Errorf("check durable storage bucket: %w", err)
	}
	if !exists {
		return nil, fmt.Errorf("durable storage bucket %q does not exist; restore the paired MinIO backup before startup", client.Bucket())
	}
	return client, nil
}

func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load configuration: %v\n", err)
		os.Exit(1)
	}

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
		if err := admin.ValidateProductionAdminPassword(); err != nil {
			logger.Fatal().Err(err).Msg("API auth is enabled but the admin password is not production-safe")
		}
	}

	db, err := database.New(cfg)
	if err != nil {
		logger.Fatal().Err(err).Msg("Failed to connect to database")
	}
	defer db.Close()

	ensureCtx, ensureCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer ensureCancel()
	if err := db.EnsureTables(ensureCtx); err != nil {
		logger.Fatal().Err(err).Msg("Failed to ensure database tables")
	}
	taskActions := actions.NewTaskActions(db.Pool)
	if _, err := taskActions.ReconcileImmediateTimeouts(ensureCtx); err != nil {
		logger.Fatal().Err(err).Msg("Failed to reconcile immediate Task deadlines")
	}
	adminAuth := admin.NewService(db.Pool, cfg)
	if admin.UsesDefaultDevelopmentPassword() {
		if cfg.EnableAPIAuth {
			logger.Fatal().Msg("API auth is enabled but development admin seed would use admin/password — set ATLAS_ADMIN_PASSWORD or ATLAS_ADMIN_PASSWORD_FILE")
		}
		logger.Warn().Msg("Development admin seed is using the default admin/password credential; set ATLAS_ADMIN_PASSWORD or ATLAS_ADMIN_PASSWORD_FILE before exposing Core")
	}
	if err := adminAuth.CleanupExpiredAuthRecords(ensureCtx, time.Now().UTC()); err != nil {
		logger.Fatal().Err(err).Msg("Failed to clean expired admin auth records")
	}
	if err := adminAuth.SeedDevelopmentAdmin(ensureCtx); err != nil {
		logger.Fatal().Err(err).Msg("Failed to seed development admin account")
	}

	storageCtx, storageCancel := context.WithTimeout(context.Background(), 30*time.Second)
	storageClient, err := initializeStorage(storageCtx, cfg)
	storageCancel()
	if err != nil {
		logger.Fatal().Err(err).Msg("Failed to initialize storage")
	}
	if storageClient == nil {
		logger.Warn().Msg("Disposable development storage unavailable; object storage features disabled")
	} else if cfg.DatabaseRecreateOnStartup {
		logger.Info().Str("bucket", storageClient.Bucket()).Msg("Cleared storage bucket because DATABASE_RECREATE_ON_STARTUP=true")
	}
	versionCtx, versionCancel := context.WithTimeout(context.Background(), 10*time.Second)
	currentVersion, err := actions.CurrentChangeVersion(versionCtx, db.Pool)
	versionCancel()
	if err != nil {
		logger.Fatal().Err(err).Msg("Failed to read current change version")
	}
	feedHub := feed.NewHub(feed.Options{})

	runtimeCtx, stopRuntime := context.WithCancel(context.Background())
	defer stopRuntime()
	go feed.NewDispatcher(db.Pool, feedHub, currentVersion).Run(runtimeCtx)
	go runImmediateTaskTimeouts(runtimeCtx, logger, taskActions)
	if storageClient != nil {
		go runStorageDeletionReconciler(
			runtimeCtx,
			logger,
			actions.NewObjectActions(db.Pool, storageClient),
			time.Minute,
			100,
		)
	}

	handler := handlers.NewHandlerWithFeed(db, storageClient, logger, cfg, feedHub, adminAuth)

	r := chi.NewRouter()

	r.Use(middleware.ClientIPFromRemoteAddr)
	r.Use(middleware.RequestID)
	r.Use(custommiddleware.RequestLogger(logger))
	r.Use(custommiddleware.Recoverer)
	r.Use(middleware.Compress(5))

	r.Use(cors.Handler(atlasCORSOptions(cfg.CORSOrigins, cfg.CORSOriginPatterns)))

	// Auth middleware must be registered before route handlers (chi requirement); public endpoints skip auth.
	if cfg.EnableAPIAuth {
		logger.Info().Msg("API key authentication enabled")
	} else {
		logger.Info().Msg("API key authentication disabled (set ENABLE_API_AUTH=true or enable_api_auth=true in atlas_core.settings.json)")
	}
	r.Use(custommiddleware.CombinedAuth(apiKey, cfg.EnableAPIAuth, adminAuth, cfg.CORSOrigins, cfg.CORSOriginPatterns))

	r.Get("/health", handler.LivenessCheck)
	r.Get("/readiness", handler.ReadinessCheck)

	r.Get("/", handler.Root)
	r.Get("/resources", handler.Resources)
	r.Get("/protocol/revision", handler.ProtocolRevision)
	r.Get("/command-catalog", handler.GetCommandCatalog)
	r.Get("/feed", handler.Feed)
	r.Post("/admin/auth/login", handler.AdminLogin)
	r.Post("/admin/auth/logout", handler.AdminLogout)
	r.Get("/admin/auth/me", handler.AdminMe)
	r.Get("/admin/api-keys", handler.AdminListAPIKeys)
	r.Post("/admin/api-keys", handler.AdminCreateAPIKey)
	r.Delete("/admin/api-keys/{key_id}", handler.AdminRevokeAPIKey)

	// Entity routes
	r.Get("/entities", handler.ListEntities)
	r.Post("/entities", handler.CreateEntity)
	r.Get("/entities/{entity_id}", handler.GetEntity)
	r.Patch("/entities/{entity_id}", handler.UpdateEntity)
	r.Delete("/entities/{entity_id}", handler.DeleteEntity)
	r.Get("/entities/alias/{alias}", handler.GetEntityByAlias)
	r.Post("/entities/{entity_id}/checkin", handler.EntityCheckin)
	r.Post("/entities/{entity_id}/runtime", handler.BeginAssetRuntime)
	r.Post("/entities/{entity_id}/runtime/ready", handler.ReadyAssetRuntime)
	r.Get("/entities/{entity_id}/runtime/tasks", handler.DeliverAssetTasks)
	r.Get("/entities/{entity_id}/tasks", handler.GetTasksByEntity)
	r.Get("/entities/{entity_id}/objects", handler.GetObjectsByEntity)

	// Task routes
	r.Get("/tasks", handler.ListTasks)
	r.Post("/tasks", handler.CreateTask)
	r.Get("/tasks/{task_id}", handler.GetTask)
	r.Post("/tasks/{task_id}/acknowledge", handler.AcknowledgeTask)
	r.Post("/tasks/{task_id}/start", handler.StartTask)
	r.Post("/tasks/{task_id}/progress", handler.ProgressTask)
	r.Post("/tasks/{task_id}/complete", handler.CompleteTask)
	r.Post("/tasks/{task_id}/fail", handler.FailTask)
	r.Post("/tasks/{task_id}/cancel", handler.CancelTask)
	r.Get("/tasks/{task_id}/objects", handler.GetObjectsByTask)

	// Object routes
	r.Get("/objects", handler.ListObjects)
	r.Post("/objects", handler.CreateObject)
	transferTimeout := custommiddleware.TransferIdleTimeout(objectTransferIdleTimeout)
	r.With(transferTimeout).Post("/objects/upload", handler.UploadObject)
	r.Get("/objects/{object_id}", handler.GetObject)
	r.Patch("/objects/{object_id}", handler.UpdateObject)
	r.Delete("/objects/{object_id}", handler.DeleteObject)
	r.With(transferTimeout).Get("/objects/{object_id}/download", handler.DownloadObject)
	r.With(transferTimeout).Get("/objects/{object_id}/view", handler.ViewObject)

	// Query routes
	r.Get("/queries/full", handler.GetFullDataset)
	r.Get("/queries/changed-since", handler.GetChangedSince)

	server := newHTTPServer(":"+cfg.ServerPort, r)

	go func() {
		logger.Info().Str("port", cfg.ServerPort).Msg("Starting HTTP server")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal().Err(err).Msg("HTTP server error")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info().Msg("ATLAS Core API shutting down...")
	stopRuntime()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error().Err(err).Msg("Server shutdown error")
	}
	feedHub.Close()

	logger.Info().Msg("ATLAS Core API shutdown complete")
}

func runImmediateTaskTimeouts(ctx context.Context, logger zerolog.Logger, tasks *actions.TaskActions) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := tasks.ReconcileImmediateTimeouts(ctx); err != nil && ctx.Err() == nil {
				logger.Error().Err(err).Msg("Immediate Task deadline reconciliation failed")
			}
		}
	}
}
