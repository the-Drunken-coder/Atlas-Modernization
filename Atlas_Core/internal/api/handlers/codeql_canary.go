package handlers

// Intentionally vulnerable CodeQL canary. DO NOT MERGE.

import (
	"database/sql"
	"fmt"
	"net/http"
)

func codeQLSQLInjectionCanary(database *sql.DB, request *http.Request) {
	query := fmt.Sprintf("SELECT name FROM assets WHERE category = '%s'", request.URL.Query().Get("category"))
	_, _ = database.Query(query)
}

var _ = codeQLSQLInjectionCanary
