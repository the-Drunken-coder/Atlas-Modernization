import { useEffect, useRef, useState } from "react";
import type { MapTarget } from "../../ui/map/interaction/map-camera.js";
import { Button } from "../../ui/primitives/controls.js";
import { PlaceIcon, SearchIcon } from "../../ui/primitives/icons.js";
import type { PlaceSearch, PlaceSearchResponse, PlaceSearchResult } from "./place-search.js";

type SearchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; response: PlaceSearchResponse }
  | { phase: "error"; message: string };

type PlacesPanelProps = {
  query: string;
  search?: PlaceSearch;
  unavailableReason?: string;
  onQueryChange: (query: string) => void;
  onPreview: (target: MapTarget | null) => void;
  onFocus: (target: MapTarget) => void;
};

const SEARCH_DEBOUNCE_MS = 250;
const PREVIEW_DELAY_MS = 250;
const MIN_QUERY_LENGTH = 2;

export function PlacesPanel({ query, search, unavailableReason, onQueryChange, onPreview, onFocus }: PlacesPanelProps) {
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const [retry, setRetry] = useState(0);
  const [hoveredResultId, setHoveredResultId] = useState<string | null>(null);
  const [focusedResultId, setFocusedResultId] = useState<string | null>(null);
  const [suppressedResultId, setSuppressedResultId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim();
  const available = Boolean(search);

  useEffect(() => {
    onPreview(null);
    setHoveredResultId(null);
    setFocusedResultId(null);
    setSuppressedResultId(null);
    if (!search || normalizedQuery.length < MIN_QUERY_LENGTH) {
      setState({ phase: "idle" });
      return;
    }

    setState({ phase: "loading" });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void search(normalizedQuery, controller.signal)
        .then((response) => {
          if (!controller.signal.aborted) setState({ phase: "ready", response });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState({ phase: "error", message: error instanceof Error ? error.message : "Place search failed." });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [normalizedQuery, onPreview, retry, search]);

  useEffect(() => () => onPreview(null), [onPreview]);

  const results = state.phase === "ready" ? state.response.results : [];
  const activeResultId = hoveredResultId ?? focusedResultId;
  const activeResult = results.find((result) => result.id === activeResultId);

  useEffect(() => {
    if (!activeResult || activeResult.id === suppressedResultId) {
      onPreview(null);
      return;
    }

    const timeout = window.setTimeout(() => onPreview(activeResult.target), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [activeResult, onPreview, suppressedResultId]);

  return (
    <div className="entity-browser">
      <label className="bp6-input-group bp6-small entity-filter">
        <SearchIcon size={14} />
        <input
          ref={inputRef}
          autoFocus
          className="bp6-input"
          type="search"
          aria-label="Search places"
          aria-describedby="place-search-help"
          placeholder="Place name or address"
          maxLength={256}
          value={query}
          disabled={!available}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
      </label>

      <div className="entity-list__summary" id="place-search-help" aria-live="polite">
        {summaryForState(state, normalizedQuery, available)}
      </div>

      {!available ? (
        <div className="panel__empty place-search__empty">
          Configure <code>VITE_MAPTILER_API_KEY</code> to search places.
          {unavailableReason && unavailableReason !== "missing key" ? <small>{unavailableReason}</small> : null}
        </div>
      ) : state.phase === "loading" ? (
        <div className="panel__empty place-search__empty" role="status">
          Searching places…
        </div>
      ) : state.phase === "error" ? (
        <div className="panel__empty place-search__empty" role="alert">
          <span>{state.message}</span>
          <Button onClick={() => setRetry((current) => current + 1)}>Retry search</Button>
        </div>
      ) : state.phase === "ready" ? (
        <>
          {results.length > 0 ? (
            <ul className="entity-list" onMouseLeave={() => setHoveredResultId(null)}>
              {results.map((result) => (
                <PlaceResultRow
                  key={result.id}
                  result={result}
                  onBlur={() => setFocusedResultId((current) => (current === result.id ? null : current))}
                  onCommit={() => {
                    setSuppressedResultId(result.id);
                    onFocus(result.target);
                  }}
                  onDismiss={() => {
                    setHoveredResultId(null);
                    setFocusedResultId(null);
                    setSuppressedResultId(result.id);
                    onPreview(null);
                    inputRef.current?.focus();
                  }}
                  onFocus={() => {
                    if (suppressedResultId === result.id) setSuppressedResultId(null);
                    setFocusedResultId(result.id);
                  }}
                  onMouseEnter={() => {
                    if (suppressedResultId === result.id) setSuppressedResultId(null);
                    setHoveredResultId(result.id);
                  }}
                />
              ))}
            </ul>
          ) : (
            <div className="panel__empty place-search__empty">No matching places.</div>
          )}
          <div className="place-search__attribution">{state.response.attribution}</div>
        </>
      ) : (
        <div className="panel__empty place-search__empty">Search by place name or address.</div>
      )}
    </div>
  );
}

function PlaceResultRow({
  result,
  onBlur,
  onCommit,
  onDismiss,
  onFocus,
  onMouseEnter
}: {
  result: PlaceSearchResult;
  onBlur: () => void;
  onCommit: () => void;
  onDismiss: () => void;
  onFocus: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="entity-row place-row"
        aria-label={result.context ? `${result.name}, ${result.context}` : result.name}
        onBlur={onBlur}
        onClick={onCommit}
        onFocus={onFocus}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }}
        onMouseEnter={onMouseEnter}
      >
        <PlaceIcon size={14} />
        <span className="entity-row__main">
          <span className="entity-row__name">{result.name}</span>
          {result.context ? <span className="entity-row__meta">{result.context}</span> : null}
          <span className="entity-row__meta place-row__coordinates">{formatCoordinates(result.coordinates)}</span>
        </span>
      </button>
    </li>
  );
}

function summaryForState(state: SearchState, query: string, available: boolean): string {
  if (!available) return "Place search unavailable";
  if (query.length < MIN_QUERY_LENGTH) return "Enter at least 2 characters";
  if (state.phase === "loading") return "Searching";
  if (state.phase === "error") return "Search error";
  if (state.phase === "ready") {
    const count = state.response.results.length;
    return `${count} ${count === 1 ? "place" : "places"}`;
  }
  return "Ready";
}

function formatCoordinates([lng, lat]: [number, number]): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
