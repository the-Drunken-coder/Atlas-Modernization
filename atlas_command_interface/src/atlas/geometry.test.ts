import { describe, expect, it } from "vitest";
import {
  addVertexAfter,
  canRemoveVertex,
  displayGeometry,
  geometryVertices,
  midpointPosition,
  moveVertex,
  removeVertex,
  representativePoint,
  toUiGeometry,
  type UiGeometry,
  validateGeometry
} from "./geometry.js";

const point: UiGeometry = { type: "Point", coordinates: [-74.2, 40.1] };
const line: UiGeometry = {
  type: "LineString",
  coordinates: [
    [-74.2, 40.1],
    [-74.1, 40.2]
  ]
};
const polygon: UiGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-74.2, 40.1],
      [-74.1, 40.1],
      [-74.1, 40.2],
      [-74.2, 40.2],
      [-74.2, 40.1]
    ]
  ]
};
const circle: UiGeometry = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-74.2, 40.1] },
  properties: { shape: "circle", radius_m: 500 }
};
const elevatedCircle: UiGeometry = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-74.2, 40.1, 37] },
  properties: { shape: "circle", radius_m: 500 }
};

describe("geometry normalisation", () => {
  it("passes through GeoJSON geometries", () => {
    expect(toUiGeometry(point)).toEqual(point);
    expect(toUiGeometry(line)).toEqual(line);
    expect(toUiGeometry(polygon)).toEqual(polygon);
    expect(toUiGeometry({ ...point, radius_m: 500 })).toBeUndefined();
  });

  it("passes through strict circle Features", () => {
    expect(toUiGeometry(circle)).toEqual(circle);
    expect(toUiGeometry(elevatedCircle)).toEqual(elevatedCircle);
    expect(toUiGeometry({ ...circle, properties: { ...circle.properties, units: "meters" } })).toBeUndefined();
    expect(toUiGeometry({ ...circle, properties: { radius_m: 500 } })).toBeUndefined();
  });

  it("returns undefined for geometry with non-finite coordinates", () => {
    expect(toUiGeometry({ type: "Point", coordinates: [Number.NaN, 40.1] })).toBeUndefined();
    expect(toUiGeometry({ type: "Point", coordinates: [-74.2, 40.1, Number.NaN] })).toBeUndefined();
    expect(
      toUiGeometry({ ...circle, geometry: { type: "Point", coordinates: [-74.2, Number.POSITIVE_INFINITY] } })
    ).toBeUndefined();
  });

  it("returns undefined for coordinates outside Protocol ranges", () => {
    expect(toUiGeometry({ type: "Point", coordinates: [180.0001, 40.1] })).toBeUndefined();
    expect(toUiGeometry({ type: "Point", coordinates: [-74.2, -90.0001] })).toBeUndefined();
  });

  it("returns undefined for missing or unsupported geometry", () => {
    expect(toUiGeometry(undefined)).toBeUndefined();
    expect(toUiGeometry({})).toBeUndefined();
    expect(toUiGeometry({ type: "MultiPoint", coordinates: [] })).toBeUndefined();
  });

  it("derives a representative point", () => {
    expect(representativePoint(point)).toEqual([-74.2, 40.1]);
    expect(representativePoint(line)).toEqual([-74.2, 40.1]);
    expect(representativePoint(polygon)).toEqual([-74.2, 40.1]);
    expect(representativePoint(circle)).toEqual([-74.2, 40.1]);
  });

  it("derives display-only polygons for circle Features", () => {
    const display = displayGeometry(circle);
    if (display.type !== "Polygon") throw new Error(`Expected Polygon display geometry, got ${display.type}`);
    const ring = display.coordinates[0];
    expect(ring).toHaveLength(65);
    expect(ring?.[0]).toEqual(ring?.[64]);
  });
});

describe("editable vertices", () => {
  it("lists one vertex for a point", () => {
    expect(geometryVertices(point)).toEqual([{ ref: { kind: "Point" }, lng: -74.2, lat: 40.1 }]);
  });

  it("excludes the polygon's repeated closing coordinate", () => {
    const vertices = geometryVertices(polygon);
    expect(vertices).toHaveLength(4);
    expect(vertices.map((v) => v.ref)).toEqual([
      { kind: "Polygon", ring: 0, index: 0 },
      { kind: "Polygon", ring: 0, index: 1 },
      { kind: "Polygon", ring: 0, index: 2 },
      { kind: "Polygon", ring: 0, index: 3 }
    ]);
  });

  it("lists the center for a circle Feature", () => {
    expect(geometryVertices(circle)).toEqual([{ ref: { kind: "Circle" }, lng: -74.2, lat: 40.1 }]);
  });
});

describe("vertex editing", () => {
  it("moves a point coordinate", () => {
    expect(moveVertex(point, { kind: "Point" }, -75, 41)).toEqual({ type: "Point", coordinates: [-75, 41] });
  });

  it("moves a circle center while preserving the Feature payload", () => {
    expect(moveVertex(circle, { kind: "Circle" }, -75, 41)).toEqual({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-75, 41] },
      properties: { shape: "circle", radius_m: 500 }
    });
    expect(moveVertex(elevatedCircle, { kind: "Circle" }, -75, 41)).toEqual({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-75, 41, 37] },
      properties: { shape: "circle", radius_m: 500 }
    });
  });

  it("moves a line vertex while preserving validity", () => {
    const elevatedLine: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2, 12]
      ]
    };
    const moved = moveVertex(elevatedLine, { kind: "LineString", index: 1 }, -73, 41);
    expect(moved).toEqual({
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-73, 41, 12]
      ]
    });
    expect(validateGeometry(moved)).toEqual({ valid: true });
  });

  it("adds and removes line vertices keeping at least two points", () => {
    const added = addVertexAfter(line, { kind: "LineString", index: 0 }, [-74.15, 40.15]);
    expect(added).toEqual({
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.15, 40.15],
        [-74.1, 40.2]
      ]
    });

    expect(canRemoveVertex(added, { kind: "LineString", index: 1 })).toBe(true);
    const removed = removeVertex(added, { kind: "LineString", index: 1 });
    expect(removed).toEqual(line);

    // A two-point line cannot lose a vertex.
    expect(canRemoveVertex(line, { kind: "LineString", index: 0 })).toBe(false);
    expect(removeVertex(line, { kind: "LineString", index: 0 })).toBeUndefined();
  });

  it("keeps the polygon ring closed when moving the first vertex", () => {
    const moved = moveVertex(polygon, { kind: "Polygon", ring: 0, index: 0 }, -75, 41) as Extract<
      UiGeometry,
      { type: "Polygon" }
    >;
    const ring = moved.coordinates[0];
    expect(ring[0]).toEqual([-75, 41]);
    expect(ring[ring.length - 1]).toEqual([-75, 41]);
    expect(validateGeometry(moved)).toEqual({ valid: true });
  });

  it("adds a polygon vertex and preserves the closed ring", () => {
    const added = addVertexAfter(polygon, { kind: "Polygon", ring: 0, index: 1 }, [-74.05, 40.15]) as Extract<
      UiGeometry,
      { type: "Polygon" }
    >;
    const ring = added.coordinates[0];
    expect(ring).toHaveLength(6);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(validateGeometry(added)).toEqual({ valid: true });
  });

  it("inserts complete positions into lines and polygon rings", () => {
    const elevatedLine: UiGeometry = {
      type: "LineString",
      coordinates: [
        [170, 10, 100, 2],
        [-170, 20, 200, 4]
      ]
    };
    expect(addVertexAfter(elevatedLine, { kind: "LineString", index: 0 }, [-180, 15, 150, 3])).toEqual({
      type: "LineString",
      coordinates: [
        [170, 10, 100, 2],
        [-180, 15, 150, 3],
        [-170, 20, 200, 4]
      ]
    });

    const elevatedPolygon: UiGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [170, 10, 100],
          [-170, 10, 200],
          [-170, 20, 300],
          [170, 10, 100]
        ]
      ]
    };
    const added = addVertexAfter(elevatedPolygon, { kind: "Polygon", ring: 0, index: 0 }, [-180, 10, 150]) as Extract<
      UiGeometry,
      { type: "Polygon" }
    >;
    expect(added.coordinates[0]).toEqual([
      [170, 10, 100],
      [-180, 10, 150],
      [-170, 10, 200],
      [-170, 20, 300],
      [170, 10, 100]
    ]);
  });

  it("removes a polygon vertex only while the ring stays valid", () => {
    expect(canRemoveVertex(polygon, { kind: "Polygon", ring: 0, index: 0 })).toBe(true);
    const removed = removeVertex(polygon, { kind: "Polygon", ring: 0, index: 2 }) as Extract<
      UiGeometry,
      { type: "Polygon" }
    >;
    expect(removed.coordinates[0]).toHaveLength(4);
    expect(removed.coordinates[0][0]).toEqual(removed.coordinates[0][3]);
    expect(validateGeometry(removed)).toEqual({ valid: true });

    // A triangle (3 distinct vertices) cannot lose another vertex.
    expect(canRemoveVertex(removed, { kind: "Polygon", ring: 0, index: 0 })).toBe(false);
    expect(removeVertex(removed, { kind: "Polygon", ring: 0, index: 0 })).toBeUndefined();
  });
});

describe("midpoint positions", () => {
  it("uses the ordinary midpoint away from the antimeridian", () => {
    const midpoint = midpointPosition([-74.2, 40.1], [-74.1, 40.2]);
    expect(midpoint[0]).toBeCloseTo(-74.15);
    expect(midpoint[1]).toBeCloseTo(40.15);
  });

  it("takes the shortest antimeridian path in either direction", () => {
    expect(midpointPosition([170, 10], [-170, 20])).toEqual([-180, 15]);
    expect(midpointPosition([-170, 10], [170, 20])).toEqual([-180, 15]);
    expect(midpointPosition([179, 0], [-179, 0])).toEqual([-180, 0]);
  });

  it("interpolates every shared dimension and uses the minimum common arity", () => {
    expect(midpointPosition([170, 10, 100, 2], [-170, 20, 200, 4])).toEqual([-180, 15, 150, 3]);
    expect(midpointPosition([10, 20, 30, 40], [20, 40, 50])).toEqual([15, 30, 40]);
    expect(midpointPosition([10, 20], [20, 40, 50])).toEqual([15, 30]);
  });
});

describe("geometry validity", () => {
  it("accepts well-formed geometries", () => {
    expect(validateGeometry(point)).toEqual({ valid: true });
    expect(validateGeometry(line)).toEqual({ valid: true });
    expect(validateGeometry(polygon)).toEqual({ valid: true });
    expect(validateGeometry(circle)).toEqual({ valid: true });
  });

  it("rejects malformed geometries with reasons", () => {
    expect(validateGeometry({ type: "LineString", coordinates: [[-74.2, 40.1]] })).toEqual({
      valid: false,
      reason: "Line needs at least two points"
    });
    expect(
      validateGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-74.2, 40.1],
            [-74.1, 40.1],
            [-74.2, 40.1]
          ]
        ]
      })
    ).toEqual({
      valid: false,
      reason: "Polygon needs a closed ring of at least four coordinates"
    });
    expect(
      validateGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-74.2, 40.1],
            [-74.1, 40.1],
            [-74.1, 40.2],
            [-74.2, 40.2]
          ]
        ]
      })
    ).toEqual({ valid: false, reason: "Polygon ring must repeat its first coordinate to close" });
    expect(
      validateGeometry({
        type: "LineString",
        coordinates: [
          [-74.2, 40.1],
          [Number.NaN, 40.2]
        ]
      })
    ).toEqual({
      valid: false,
      reason: "Line contains an invalid coordinate"
    });
    expect(
      validateGeometry({
        type: "LineString",
        coordinates: [
          [-74.2, 40.1],
          [-74.1, 40.2, Number.NaN]
        ]
      })
    ).toEqual({
      valid: false,
      reason: "Line contains an invalid coordinate"
    });
    expect(
      validateGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-74.2, 40.1],
            [-74.1, 40.1],
            [Number.POSITIVE_INFINITY, 40.2],
            [-74.2, 40.1]
          ]
        ]
      })
    ).toEqual({ valid: false, reason: "Polygon contains an invalid coordinate" });
    expect(
      validateGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-74.2, 40.1],
            [-74.1, 40.1],
            [-74.1, 40.2],
            [-74.2, 40.2],
            [-74.2, 40.1]
          ],
          [
            [-74.15, 40.15],
            [-74.12, 40.15],
            [-74.12, 40.18],
            [-74.15, 40.18]
          ]
        ]
      })
    ).toEqual({ valid: false, reason: "Polygon ring must repeat its first coordinate to close" });
    expect(validateGeometry({ ...circle, properties: { shape: "circle", radius_m: 0 } })).toEqual({
      valid: false,
      reason: "Circle radius must be greater than zero"
    });
  });
});
