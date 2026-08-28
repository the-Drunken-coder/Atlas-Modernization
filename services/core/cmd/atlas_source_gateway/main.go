// Package main runs the private Atlas Source Gateway.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/services/core/internal/sourcegateway"
)

func main() {
	configPath := os.Getenv("ATLAS_SOURCE_GATEWAY_CONFIG")
	if configPath == "" {
		configPath = "source_gateway.json"
	}
	configuration, err := sourcegateway.LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load Source Gateway configuration: %v\n", err)
		os.Exit(1)
	}
	logger := zerolog.New(os.Stdout).With().Timestamp().Str("service", "atlas-source-gateway").Logger()
	gateway, err := sourcegateway.New(configuration, sourcegateway.Options{Logger: logger})
	if err != nil {
		logger.Fatal().Err(err).Msg("Failed to initialize Source Gateway")
	}
	server := &http.Server{
		Addr: configuration.ListenAddress, Handler: gateway.Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			logger.Error().Err(err).Msg("Source Gateway shutdown failed")
		}
	}()
	logger.Info().Str("address", configuration.ListenAddress).Msg("Atlas Source Gateway starting")
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatal().Err(err).Msg("Source Gateway stopped unexpectedly")
	}
}
