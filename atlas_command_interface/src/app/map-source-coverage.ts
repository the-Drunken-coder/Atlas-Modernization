export type MapCoverageBounds = readonly [west: number, south: number, east: number, north: number];

export type MapSourceCoverage = {
  readonly bounds?: readonly MapCoverageBounds[];
  readonly minZoom: number;
  readonly maxZoom: number;
};

export type MapViewport = {
  bounds: MapCoverageBounds;
  zoom: number;
};

export type MapSourceCoverageResult = {
  kind: "loading" | "full" | "partial" | "none" | "zoom" | "unknown";
  reason: string;
  selectable: boolean;
};

type FlatBounds = { west: number; south: number; east: number; north: number };

/** Classify declared provider coverage against the live MapLibre viewport. */
export function mapSourceCoverageAtViewport(
  coverage: MapSourceCoverage | undefined,
  viewport: MapViewport | undefined
): MapSourceCoverageResult {
  if (!viewport) return { kind: "loading", reason: "Checking viewport coverage", selectable: true };
  if (!coverage) return { kind: "unknown", reason: "Coverage metadata not published", selectable: true };

  if (viewport.zoom < coverage.minZoom) {
    return {
      kind: "zoom",
      reason: `Zoom ${formatZoom(viewport.zoom)} is below supported min ${formatZoom(coverage.minZoom)}`,
      selectable: false
    };
  }
  if (viewport.zoom > coverage.maxZoom) {
    return {
      kind: "zoom",
      reason: `Zoom ${formatZoom(viewport.zoom)} exceeds supported max ${formatZoom(coverage.maxZoom)}`,
      selectable: false
    };
  }
  if (!coverage.bounds?.length) {
    return { kind: "unknown", reason: "Coverage metadata not published", selectable: true };
  }

  const viewportParts = splitAntimeridian(viewport.bounds);
  const coverageParts = coverage.bounds.flatMap(splitAntimeridian);
  const overlaps = viewportParts.some((part) => coverageParts.some((candidate) => intersection(part, candidate)));
  if (!overlaps) return { kind: "none", reason: "Viewport is outside source bounds", selectable: false };

  const uncovered = coverageParts.reduce(
    (parts, candidate) => parts.flatMap((part) => subtract(part, candidate)),
    viewportParts
  );
  if (uncovered.length === 0) return { kind: "full", reason: "Full viewport covered", selectable: true };
  return { kind: "partial", reason: "Part of viewport is outside source bounds", selectable: true };
}

function splitAntimeridian([west, south, east, north]: MapCoverageBounds): FlatBounds[] {
  if (north <= south) return [];

  let span = east - west;
  while (span < 0) span += 360;
  if (span >= 360) return [{ west: -180, south, east: 180, north }];

  const normalizedWest = ((((west + 180) % 360) + 360) % 360) - 180;
  const normalizedEast = normalizedWest + span;
  if (normalizedEast <= 180) return [{ west: normalizedWest, south, east: normalizedEast, north }];
  return [
    { west: normalizedWest, south, east: 180, north },
    { west: -180, south, east: normalizedEast - 360, north }
  ];
}

function intersection(a: FlatBounds, b: FlatBounds): FlatBounds | undefined {
  const overlap = {
    west: Math.max(a.west, b.west),
    south: Math.max(a.south, b.south),
    east: Math.min(a.east, b.east),
    north: Math.min(a.north, b.north)
  };
  return overlap.west < overlap.east && overlap.south < overlap.north ? overlap : undefined;
}

function subtract(source: FlatBounds, cover: FlatBounds): FlatBounds[] {
  const overlap = intersection(source, cover);
  if (!overlap) return [source];

  const parts: FlatBounds[] = [];
  if (source.west < overlap.west) {
    parts.push({ ...source, east: overlap.west });
  }
  if (overlap.east < source.east) {
    parts.push({ ...source, west: overlap.east });
  }
  if (source.south < overlap.south) {
    parts.push({ west: overlap.west, south: source.south, east: overlap.east, north: overlap.south });
  }
  if (overlap.north < source.north) {
    parts.push({ west: overlap.west, south: overlap.north, east: overlap.east, north: source.north });
  }
  return parts;
}

function formatZoom(zoom: number): string {
  return Number.isInteger(zoom) ? String(zoom) : String(Math.round(zoom * 10) / 10);
}
