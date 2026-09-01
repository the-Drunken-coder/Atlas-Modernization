import type { SpatialFeature } from "@the-drunken-coder/atlas-sdk";
import { MapWindow } from "../../ui/map/view/MapWindow.js";
import { PanelListRow } from "../shared/PanelListRow.js";
import { FieldGrid } from "../shared/panels.js";
import { formatSpatialReason, formatSpatialRetrievalTime } from "./spatial-format.js";
import type { SpatialOperationRunner } from "./use-spatial-operation-runner.js";

export function SpatialResultsInspector({
  spatial,
  onPreviewFeature,
  onFocusFeature
}: {
  spatial: SpatialOperationRunner;
  onPreviewFeature(feature?: SpatialFeature): void;
  onFocusFeature(feature: SpatialFeature): void;
}) {
  const result = spatial.result;
  if (!spatial.target || !result) return null;

  const selected = spatial.selectedFeature;
  const resultCount = result.features.length;
  const resultLabel = `${resultCount} result${resultCount === 1 ? "" : "s"}`;
  const resultState = [spatial.stale ? "stale" : undefined, result.truncation ? "truncated" : undefined]
    .filter(Boolean)
    .join(" · ");

  return (
    <MapWindow
      id="spatial-results"
      title={spatial.target.operationName}
      meta={resultState ? `${resultLabel} · ${resultState}` : resultLabel}
      onClose={spatial.clear}
      footer={
        <>
          <span className="spatial-map-window__source" title={result.provenance.source}>
            {result.provenance.source} · {formatSpatialRetrievalTime(result.retrieved_at)}
          </span>
          <a href={result.attribution.url} target="_blank" rel="noreferrer">
            {result.attribution.text}
          </a>
        </>
      }
    >
      {spatial.status === "loading" || spatial.stale || spatial.error || result.truncation ? (
        <div
          className={`spatial-map-window__notice${spatial.error ? " spatial-map-window__notice--error" : ""}`}
          role={spatial.error ? "alert" : "status"}
        >
          {spatial.error
            ? `${spatial.error} Previous results retained.`
            : spatial.status === "loading"
              ? "Refreshing. Previous results retained."
              : spatial.stale
                ? "Results are stale."
                : `Results truncated: ${formatSpatialReason(result.truncation?.reason ?? "")}`}
        </div>
      ) : null}

      {resultCount === 0 ? (
        <div className="spatial-map-window__empty">No results in this area.</div>
      ) : (
        <div className="spatial-map-window__content">
          <ul className="entity-list spatial-map-window__results" aria-label="Spatial results">
            {result.features.map((feature) => (
              <li key={feature.id}>
                <PanelListRow
                  className="spatial-map-window__result"
                  title={feature.title}
                  meta={feature.id}
                  indicatorColor="var(--map-geofeature)"
                  selected={selected?.id === feature.id}
                  showChevron={false}
                  onBlur={() => onPreviewFeature()}
                  onClick={() => {
                    spatial.selectFeature(feature.id);
                    onPreviewFeature();
                    onFocusFeature(feature);
                  }}
                  onFocus={() => onPreviewFeature(feature)}
                  onMouseEnter={() => onPreviewFeature(feature)}
                  onMouseLeave={() => onPreviewFeature()}
                />
              </li>
            ))}
          </ul>

          <section className="spatial-map-window__detail" aria-label="Selected result">
            {selected ? (
              <>
                <div className="spatial-map-window__selection-heading">
                  <strong>{selected.title}</strong>
                  <span>{selected.id}</span>
                </div>
                <FieldGrid
                  rows={[
                    ["Geometry", selected.geometry.type],
                    ...selected.fields.map((field): [string, string] => [field.label, field.value])
                  ]}
                />
              </>
            ) : (
              <span className="inspector__empty-value">Select a result on the map or in this window.</span>
            )}
          </section>
        </div>
      )}
    </MapWindow>
  );
}
