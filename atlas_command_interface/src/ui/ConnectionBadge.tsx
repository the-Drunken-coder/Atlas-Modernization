import { useEffect, useId, useMemo, useRef, useState } from "react";
import { sanitizeConnectionError } from "../atlas/connection-error.js";
import type { ConnectionError, ConnectionHealth } from "../atlas/data-source.js";
import { Button } from "./primitives/controls.js";

export function ConnectionBadge({
  health,
  error,
  focusOnMount = false,
  onRetry
}: {
  health: ConnectionHealth;
  error?: ConnectionError;
  focusOnMount?: boolean;
  onRetry: () => void;
}) {
  const unsafeConnectionError = error ?? health.error;
  const errorMessage = unsafeConnectionError?.message;
  const errorSource = unsafeConnectionError?.source;
  const connectionError = useMemo(
    () =>
      errorMessage === undefined || errorSource === undefined
        ? undefined
        : { message: sanitizeConnectionError(errorMessage), source: errorSource },
    [errorMessage, errorSource]
  );
  const state = connectionBadgeState(health, connectionError);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const focusAnchorRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const retryFocusPendingRef = useRef(false);
  const ownsFocusRef = useRef(false);
  const detailId = `connection-error-${useId()}`;

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (focusOnMount && connectionError) triggerRef.current?.focus();
  }, [connectionError, focusOnMount]);

  useEffect(() => {
    if (
      connectionError ||
      (retryFocusPendingRef.current && !(health.healthy && !health.degraded)) ||
      (!open && !ownsFocusRef.current)
    )
      return;
    setOpen(false);
    const activeElement = document.activeElement;
    if (
      activeElement === document.body ||
      detailRef.current?.contains(activeElement) ||
      focusAnchorRef.current?.contains(activeElement)
    ) {
      statusRef.current?.focus();
    }
  }, [connectionError, health.degraded, health.healthy, open]);

  useEffect(() => {
    if (!connectionError || !ownsFocusRef.current || document.activeElement !== document.body) return;
    triggerRef.current?.focus();
  }, [connectionError]);

  useEffect(() => {
    if (!retryFocusPendingRef.current) return;
    if (connectionError) {
      retryFocusPendingRef.current = false;
      triggerRef.current?.focus();
    } else if (health.healthy && !health.degraded) {
      retryFocusPendingRef.current = false;
      statusRef.current?.focus();
    }
  }, [connectionError, health.degraded, health.healthy]);

  const badgeContent = (
    <>
      <span className="connection-badge__dot" aria-hidden="true" />
      <span>{state.label}</span>
    </>
  );

  return (
    <div
      ref={focusAnchorRef}
      className="connection-badge__anchor"
      tabIndex={-1}
      onFocusCapture={() => {
        ownsFocusRef.current = true;
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) ownsFocusRef.current = false;
      }}
    >
      <span
        className="connection-badge__status"
        role="status"
        aria-live="polite"
        aria-label={`Atlas connection ${state.label}`}
      >
        {state.label}
      </span>
      {!connectionError ? (
        <div ref={statusRef} className="connection-badge" data-state={state.state} tabIndex={-1}>
          {badgeContent}
        </div>
      ) : (
        <>
          <Button
            ref={triggerRef}
            variant="ghost"
            className="connection-badge"
            data-state={state.state}
            aria-label="Atlas connection error"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((current) => !current)}
          >
            {badgeContent}
          </Button>
          {open ? (
            <div
              ref={detailRef}
              className="connection-detail"
              id={detailId}
              role="dialog"
              aria-labelledby={`${detailId}-title`}
              aria-describedby={`${detailId}-description`}
            >
              <div className="connection-detail__header">
                <strong id={`${detailId}-title`}>Atlas Core connection error</strong>
                <Button
                  ref={closeRef}
                  variant="ghost"
                  className="connection-detail__close"
                  aria-label="Close connection details"
                  onClick={() => {
                    setOpen(false);
                    (triggerRef.current ?? focusAnchorRef.current)?.focus();
                  }}
                >
                  ×
                </Button>
              </div>
              <p id={`${detailId}-description`}>
                {connectionError.source === "startup"
                  ? "The initial connection to Atlas Core failed."
                  : "The live connection to Atlas Core failed."}
              </p>
              <p className="connection-detail__message">{connectionError.message}</p>
              <p className="connection-detail__status" role="status">
                {health.running ? "Retrying automatically…" : "Retry is available."}
              </p>
              <div className="connection-detail__actions">
                <Button
                  variant="primary"
                  onClick={() => {
                    retryFocusPendingRef.current = true;
                    setOpen(false);
                    focusAnchorRef.current?.focus();
                    onRetry();
                  }}
                >
                  Retry connection
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function connectionBadgeState(
  health: ConnectionHealth,
  error?: ConnectionError
): { label: string; state: "live" | "reconnecting" | "connecting" | "error" } {
  if (error) return { label: "Connection error", state: "error" };
  if (health.running && health.healthy && !health.degraded) return { label: "Online", state: "live" };
  if (health.running) return { label: "Reconnecting", state: "reconnecting" };
  return { label: "Connecting", state: "connecting" };
}
