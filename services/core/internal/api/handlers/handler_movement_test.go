package handlers

import (
	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
	"github.com/the-drunken-coder/atlas/services/core/internal/config"
	atlasdb "github.com/the-drunken-coder/atlas/services/core/internal/database"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestMovementRoutes(t *testing.T) {
	pool := openIsolatedFeedIntegrationPool(t)
	h := NewHandler(&atlasdb.DB{Pool: pool}, nil, zerolog.Nop(), &config.Config{})
	e, err := h.entityActions.Create(t.Context(), actions.CreateEntityParams{EntityID: "history-routes", EntityType: "track"})
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	r.Post("/entities/{entity_id}/movement-history", h.ImportMovement)
	r.Get("/entities/{entity_id}/movement-history", h.GetMovementHistory)
	r.Get("/entities/{entity_id}/trail", h.GetMovementTrail)
	r.Get("/entities/{entity_id}/movement-history/at", h.InspectMovement)
	created := e.CreatedAt.Format(time.RFC3339Nano)
	at := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	path := "/entities/history-routes/movement-history"
	var imported protocol.MovementHistoryBatchResponse
	requestTaskingRoute(t, r, http.MethodPost, path, map[string]any{"entity_created_at": created, "samples": []map[string]any{{"sample_id": "past", "observed_at": at, "latitude": 0, "longitude": 0}}}, nil, http.StatusOK, &imported)
	if imported.Inserted != 1 {
		t.Fatalf("import: %+v", imported)
	}
	requestTaskingRoute(t, r, http.MethodPost, path, map[string]any{"entity_created_at": created, "samples": []map[string]any{{"sample_id": "half", "latitude": 0}}}, nil, http.StatusBadRequest, nil)
	q := url.Values{"entity_created_at": {created}, "from": {at}, "to": {time.Now().UTC().Format(time.RFC3339Nano)}}
	var page protocol.MovementHistoryPage
	requestTaskingRoute(t, r, http.MethodGet, path+"?"+q.Encode(), nil, nil, http.StatusOK, &page)
	if len(page.Samples) != 1 || page.Samples[0].Latitude == nil || *page.Samples[0].Latitude != 0 || page.Samples[0].TimeIsArrival {
		t.Fatalf("page: %+v", page)
	}
	var trail protocol.MovementTrail
	requestTaskingRoute(t, r, http.MethodGet, "/entities/history-routes/trail?"+q.Encode(), nil, nil, http.StatusOK, &trail)
	if len(trail.Points) != 1 {
		t.Fatalf("trail: %+v", trail)
	}
	var reading protocol.MovementInspection
	requestTaskingRoute(t, r, http.MethodGet, path+"/at?"+url.Values{"entity_created_at": {created}, "at": {at}}.Encode(), nil, nil, http.StatusOK, &reading)
	if reading.Position == nil || reading.Speed != nil {
		t.Fatalf("inspection: %+v", reading)
	}
	requestTaskingRoute(t, r, http.MethodGet, path, nil, nil, http.StatusBadRequest, nil)
	q.Set("entity_created_at", at)
	requestTaskingRoute(t, r, http.MethodGet, path+"?"+q.Encode(), nil, nil, http.StatusPreconditionFailed, nil)
}
