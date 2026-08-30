package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/plugins"
)

const maxPluginOperationInputBytes = 1 << 20

type pluginRegistry interface {
	List() []protocol.PluginStatus
	Invoke(context.Context, string, string, json.RawMessage) (protocol.JSONValue, *plugins.InvokeError)
}

func (h *Handler) ListPlugins(w http.ResponseWriter, r *http.Request) {
	if h.plugins == nil {
		writeJSON(w, r, http.StatusOK, []protocol.PluginStatus{})
		return
	}
	writeJSON(w, r, http.StatusOK, h.plugins.List())
}

func (h *Handler) InvokePluginOperation(w http.ResponseWriter, r *http.Request) {
	if h.plugins == nil {
		h.writeError(w, r, http.StatusNotFound, "Plugin or Operation not found", protocol.ErrorCodePluginNotFound)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPluginOperationInputBytes)
	var input json.RawMessage
	if !h.decodeJSONRequestBody(w, r, &input, false) {
		return
	}
	var value protocol.JSONValue
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", protocol.ErrorCodeInvalidJSON)
		return
	}
	result, err := h.plugins.Invoke(r.Context(), chi.URLParam(r, "plugin_id"), chi.URLParam(r, "operation_id"), input)
	if err == nil {
		writeJSON(w, r, http.StatusOK, result)
		return
	}
	h.writePluginInvokeError(w, r, err)
}

func (h *Handler) writePluginInvokeError(w http.ResponseWriter, r *http.Request, err *plugins.InvokeError) {
	switch err.Kind {
	case plugins.InvokeCanceled:
		return
	case plugins.InvokeNotFound:
		h.writeError(w, r, http.StatusNotFound, "Plugin or Operation not found", protocol.ErrorCodePluginNotFound)
	case plugins.InvokeInputRejected:
		details := map[string]protocol.JSONValue{"plugin_code": err.PluginCode}
		if err.HasDetails {
			details["plugin_details"] = err.PluginDetails
		}
		h.writeErrorWithDetails(w, r, http.StatusBadRequest, "Plugin rejected the Operation input", protocol.ErrorCodePluginInputRejected, details, err)
	case plugins.InvokeUnavailable:
		h.writeErrorWithDetails(w, r, http.StatusServiceUnavailable, "Plugin is unavailable", protocol.ErrorCodePluginUnavailable, map[string]protocol.JSONValue{"reason_code": err.ReasonCode}, err)
	case plugins.InvokeTimeout:
		h.writeError(w, r, http.StatusGatewayTimeout, "Plugin Operation timed out", protocol.ErrorCodePluginTimeout)
	default:
		details := map[string]protocol.JSONValue{}
		if err.PluginCode != "" {
			details["plugin_code"] = err.PluginCode
		}
		if err.HasDetails {
			details["plugin_details"] = err.PluginDetails
		}
		if err.ReasonCode != "" {
			details["reason_code"] = err.ReasonCode
		}
		if len(details) == 0 {
			details = nil
		}
		h.writeErrorWithDetails(w, r, http.StatusBadGateway, "Plugin Operation failed", protocol.ErrorCodePluginFailure, details, err)
	}
}
