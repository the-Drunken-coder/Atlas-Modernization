import { useEffect, useState } from "react";
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
const MIN_QUERY_LENGTH = 2;

export function PlacesPanel({ query, search, unavailableReason, onQueryChange, onPreview, onFocus }: PlacesPanelProps) {
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const [retry, setRetry] = useState(0);
  const normalizedQuery = query.trim();
  const available = Boolean(search);

  useEffect(() => {
    onPreview(null);
    if (!search || normalizedQuery.length < MIN_QUERY_LENGTH) {
      setState({ phase: "idle" });
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setState({ phase: "loading" });
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

  return (
    <div className="entity-browser">
      <label className="bp6-input-group bp6-small entity-filter">
        <SearchIcon size={14} />
        <input
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
      ) : state.phase === "ready" && results.length === 0 ? (
        <div className="panel__empty place-search__empty">No matching places.</div>
      ) : results.length > 0 ? (
        <>
          <ul className="entity-list">
            {results.map((result) => (
              <PlaceResultRow key={result.id} result={result} onPreview={onPreview} onFocus={onFocus} />
            ))}
          </ul>
          <div className="place-search__attribution">{state.phase === "ready" ? state.response.attribution : null}</div>
        </>
      ) : (
        <div className="panel__empty place-search__empty">Search by place name or address.</div>
      )}
    </div>
  );
}

function PlaceResultRow({
  result,
  onPreview,
  onFocus
}: {
  result: PlaceSearchResult;
  onPreview: (target: MapTarget | null) => void;
  onFocus: (target: MapTarget) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="entity-row place-row"
        aria-label={result.context ? `${result.name}, ${result.context}` : result.name}
        onBlur={() => onPreview(null)}
        onClick={() => onFocus(result.target)}
        onFocus={() => onPreview(result.target)}
        onMouseEnter={() => onPreview(result.target)}
        onMouseLeave={(event) => {
          if (document.activeElement !== event.currentTarget) onPreview(null);
        }}
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
