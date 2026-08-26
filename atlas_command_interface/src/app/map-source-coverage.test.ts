import { describe, expect, it } from "vitest";
import { type MapSourceCoverage, type MapViewport, mapSourceCoverageAtViewport } from "./map-source-coverage.js";

const regionalCoverage: MapSourceCoverage = {
  bounds: [[-80, 30, -60, 50]],
  minZoom: 2,
  maxZoom: 20
};

function viewport(bounds: MapViewport["bounds"], zoom = 10): MapViewport {
  return { bounds, zoom };
}

describe("mapSourceCoverageAtViewport", () => {
  it("keeps loading and unknown coverage selectable", () => {
    expect(mapSourceCoverageAtViewport(regionalCoverage, undefined)).toEqual({
      kind: "loading",
      reason: "Checking viewport coverage",
      selectable: true
    });
    expect(mapSourceCoverageAtViewport(undefined, viewport([-70, 35, -65, 40]))).toEqual({
      kind: "unknown",
      reason: "Coverage metadata not published",
      selectable: true
    });
    expect(mapSourceCoverageAtViewport({ minZoom: 0, maxZoom: 22 }, viewport([-70, 35, -65, 40]))).toEqual({
      kind: "unknown",
      reason: "Coverage metadata not published",
      selectable: true
    });
  });

  it("treats min and max zoom as inclusive boundaries", () => {
    expect(mapSourceCoverageAtViewport(regionalCoverage, viewport([-70, 35, -65, 40], 2)).kind).toBe("full");
    expect(mapSourceCoverageAtViewport(regionalCoverage, viewport([-70, 35, -65, 40], 20)).kind).toBe("full");
    expect(mapSourceCoverageAtViewport(regionalCoverage, viewport([-70, 35, -65, 40], 1.5))).toEqual({
      kind: "zoom",
      reason: "Zoom 1.5 is below supported min 2",
      selectable: false
    });
    expect(mapSourceCoverageAtViewport(regionalCoverage, viewport([-70, 35, -65, 40], 21.4))).toEqual({
      kind: "zoom",
      reason: "Zoom 21.4 exceeds supported max 20",
      selectable: false
    });
  });

  it("distinguishes full, partial, and absent geographic coverage", () => {
    expect(mapSourceCoverageAtViewport(regionalCoverage, viewport([-80, 30, -60, 50]))).toEqual({
      kind: "full",
      reason: "Full viewport covered",
      selectable: true
    });
    expect(mapSourceCoverageAtViewport(regionalCoverage, viewport([-65, 35, -55, 40]))).toEqual({
      kind: "partial",
      reason: "Part of viewport is outside source bounds",
      selectable: true
    });
    expect(mapSourceCoverageAtViewport(regionalCoverage, viewport([-50, 35, -40, 40]))).toEqual({
      kind: "none",
      reason: "Viewport is outside source bounds",
      selectable: false
    });
  });

  it("does not count an edge-only intersection as coverage", () => {
    expect(mapSourceCoverageAtViewport(regionalCoverage, viewport([-60, 35, -50, 40])).kind).toBe("none");
  });

  it("recognizes full coverage assembled from adjacent declared bounds", () => {
    const coverage: MapSourceCoverage = {
      bounds: [
        [-80, 30, -70, 50],
        [-70, 30, -60, 50]
      ],
      minZoom: 0,
      maxZoom: 20
    };

    expect(mapSourceCoverageAtViewport(coverage, viewport([-75, 35, -65, 45])).kind).toBe("full");
  });

  it("matches viewports and provider bounds that cross the antimeridian", () => {
    const coverage: MapSourceCoverage = {
      bounds: [[170, -20, -170, 20]],
      minZoom: 0,
      maxZoom: 20
    };

    expect(mapSourceCoverageAtViewport(coverage, viewport([175, -10, -175, 10])).kind).toBe("full");
    expect(mapSourceCoverageAtViewport(coverage, viewport([175, -10, -165, 10])).kind).toBe("partial");
    expect(mapSourceCoverageAtViewport(coverage, viewport([-10, -10, 10, 10])).kind).toBe("none");
  });

  it("normalizes unwrapped MapLibre bounds around the antimeridian", () => {
    const coverage: MapSourceCoverage = {
      bounds: [[170, -20, -170, 20]],
      minZoom: 0,
      maxZoom: 20
    };

    expect(mapSourceCoverageAtViewport(coverage, viewport([175, -10, 185, 10])).kind).toBe("full");
  });
});
