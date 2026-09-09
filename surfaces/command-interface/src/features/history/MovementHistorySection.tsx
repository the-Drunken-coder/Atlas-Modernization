import { HTMLSelect } from "@blueprintjs/core";
import type { MovementSample } from "@the-drunken-coder/atlas-sdk";
import { useState } from "react";
import { Button, TextField } from "../../ui/primitives/controls.js";
import { FieldGrid, Section } from "../shared/panels.js";
import type { MovementHistoryState } from "./use-movement-history.js";

export function movementAge(sample: MovementSample | undefined, at: string) {
  return sample && Date.parse(at) - Date.parse(sample.time) > 60000
    ? `${Math.floor((Date.parse(at) - Date.parse(sample.time)) / 60000)} min old`
    : undefined;
}
const reportTime = (time: string) => new Date(time).toISOString().slice(5, 19).replace("T", " ");

export function MovementHistorySection({ history: h }: { history: MovementHistoryState }) {
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [customDraft, setCustomDraft] = useState(false);
  const [rangeError, setRangeError] = useState<string>();
  const samples = h.data?.page.samples ?? [];
  const selectedIndex = samples.findIndex((s) => s.sample_id === h.sample?.sample_id);
  const choose = (index: number) => {
    const sample = samples[index];
    if (sample) h.pin(sample);
  };
  const readings = h.inspection;
  const reading = (value: number | undefined, sample: MovementSample | undefined, unit = "", digits = 1) => {
    if (value === undefined) return "N/A";
    const age = h.sample && movementAge(sample, h.sample.time);
    return (
      <>
        {value.toFixed(digits)}
        {unit && ` ${unit}`}
        {age && <span className="movement-history__age"> · {age}</span>}
      </>
    );
  };
  return (
    <Section
      title="Movement History"
      actions={
        <Button variant="ghost" small aria-expanded={h.open} onClick={h.toggle}>
          {h.open ? "Hide" : "Show"}
        </Button>
      }
    >
      {h.open && (
        <div
          className="movement-history"
          onKeyDown={(event) => {
            if (event.key === "Escape" && h.dismiss()) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <label className="movement-history__row">
            Range{" "}
            <HTMLSelect
              aria-label="History range"
              value={customDraft || h.custom ? "custom" : String(h.duration)}
              onChange={(event) => {
                if (event.target.value === "custom") setCustomDraft(true);
                else {
                  setCustomDraft(false);
                  h.changeRange(Number(event.target.value));
                }
              }}
              options={[
                { value: "3600000", label: "Last hour" },
                { value: "86400000", label: "Last 24 hours" },
                { value: "2592000000", label: "Last 30 days" },
                { value: "custom", label: "Custom interval" }
              ]}
            />
          </label>
          {customDraft && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const from = Date.parse(`${customFrom}Z`);
                const to = Date.parse(`${customTo}Z`);
                if (Number.isFinite(from) && Number.isFinite(to) && from <= to && to - from <= 2592000000) {
                  setRangeError(undefined);
                  h.changeRange(0, { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
                  setCustomDraft(false);
                } else setRangeError("Choose an ordered interval of at most 30 days.");
              }}
            >
              <TextField
                label="From (UTC)"
                type="datetime-local"
                required
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <TextField
                label="To (UTC)"
                type="datetime-local"
                required
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
              {rangeError && <div role="alert">{rangeError}</div>}
              <Button type="submit">Apply interval</Button>
            </form>
          )}
          {h.data?.page.retention_advanced && (
            <div className="movement-history__meta">
              Retention advanced while browsing. Reports before {reportTime(h.data.page.retained_from)} UTC are
              unavailable.
            </div>
          )}
          {h.loading && <div role="status">{h.data ? "Refreshing history…" : "Loading history…"}</div>}
          {h.error && (
            <div role="alert">
              {h.error}
              {h.data && " Previous history retained."}{" "}
              <Button small onClick={h.refresh}>
                Retry
              </Button>
            </div>
          )}
          {!h.loading && !h.error && !samples.length && <div>No movement reports in this interval.</div>}
          {samples.length > 0 && (
            <>
              <div
                className="movement-history__row"
                role="group"
                aria-label="Historical report controls"
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    event.stopPropagation();
                    choose(selectedIndex + (event.key === "ArrowLeft" ? 1 : -1));
                  }
                }}
              >
                <span>Report</span>
                <Button
                  small
                  aria-label="Previous report"
                  disabled={selectedIndex >= samples.length - 1}
                  onClick={() => choose(selectedIndex + 1)}
                >
                  ←
                </Button>
                <HTMLSelect
                  aria-label="Historical report"
                  value={h.sample?.sample_id ?? ""}
                  onChange={(event) => {
                    const s = samples.find((s) => s.sample_id === event.target.value);
                    if (s) h.pin(s);
                  }}
                >
                  {!h.sample && <option value="">Select report</option>}
                  {h.sample && selectedIndex < 0 && (
                    <option value={h.sample.sample_id}>{reportTime(h.sample.time)}</option>
                  )}
                  {samples.map((s) => (
                    <option key={s.sample_id} value={s.sample_id}>
                      {reportTime(s.time)}
                      {s.latitude === undefined ? " · reading" : ""}
                    </option>
                  ))}
                </HTMLSelect>
                <Button
                  small
                  aria-label="Next report"
                  disabled={selectedIndex <= 0}
                  onClick={() => choose(selectedIndex - 1)}
                >
                  →
                </Button>
              </div>
              <div className="movement-history__row movement-history__meta">
                <span>
                  {h.preview ? "Preview" : h.following ? "Following" : h.sample ? "Pinned" : "Past interval"} · UTC
                </span>
                <Button variant="ghost" small onClick={h.refresh}>
                  Refresh
                </Button>
                {!h.following && (
                  <Button variant="ghost" small onClick={h.recent}>
                    Return to recent
                  </Button>
                )}
              </div>
              {h.sample && (
                <>
                  <FieldGrid
                    rows={[
                      ["Latitude", reading(readings?.position?.latitude, readings?.position, "", 5)],
                      ["Longitude", reading(readings?.position?.longitude, readings?.position, "", 5)],
                      ["Altitude", reading(readings?.altitude?.altitude_m, readings?.altitude, "m", 0)],
                      ["Speed", reading(readings?.speed?.speed_m_s, readings?.speed, "m/s")]
                    ]}
                  />
                  {!readings && <div role="status">{h.inspectionError ?? "Loading report…"}</div>}
                  <details>
                    <summary>Report times</summary>
                    <FieldGrid
                      rows={[
                        ["Position", readings?.position?.time],
                        ["Altitude", readings?.altitude?.time],
                        ["Speed", readings?.speed?.time]
                      ]}
                    />
                    <div>
                      {[readings?.position, readings?.altitude, readings?.speed].some((s) => s?.time_is_arrival)
                        ? "Some times use Atlas arrival time; measurement time is unknown."
                        : "Source measurement times."}
                    </div>
                  </details>
                  {h.sample.time_is_arrival && (
                    <div className="movement-history__meta">Measurement time unknown. Showing arrival time.</div>
                  )}
                </>
              )}
              <div className="movement-history__row">
                <Button small disabled={!h.canGoNewer} onClick={() => h.navigatePage(false)}>
                  Newer reports
                </Button>
                <Button small disabled={!h.data?.page.next_cursor} onClick={() => h.navigatePage(true)}>
                  Older reports
                </Button>
              </div>
              {h.data?.trail.simplified && (
                <div className="movement-history__meta">Reduced detail across the interval.</div>
              )}
              {!h.data?.trail.points.length && <div>No reported positions in this interval.</div>}
              <div className="movement-history__legend">
                <span>━━ Reported trail</span>
                <span>···· Position gap</span>
              </div>
            </>
          )}
        </div>
      )}
    </Section>
  );
}
