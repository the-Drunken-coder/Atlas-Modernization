import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import {
  BufferGeometry,
  Camera,
  CircleGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Path,
  RingGeometry,
  Scene,
  Shape,
  ShapeGeometry,
  Vector3,
  WebGLRenderer
} from "three";
import type { MapFeature, MapSources } from "./map-sources.js";
import { THREE_TACTICAL_LAYER_ID } from "./three-layer-contract.js";

const MAX_MERCATOR_LATITUDE = 85.051129;
const TILE_SIZE = 512;
const COLORS = {
  asset: 0x5ad8ff,
  track: 0xffc857,
  geofeature: 0x42e8b4,
  hostile: 0xff6b6b,
  selected: 0xffffff
};

type ScreenSpaceObject = { object: Object3D; pixels: number };
type Pulse = { material: MeshBasicMaterial; object: Object3D; pixels: number };

/**
 * Three.js owns Atlas' animated tactical overlay while MapLibre remains the
 * basemap, projection, and camera authority. Sharing MapLibre's WebGL context
 * avoids a second canvas and keeps the scene exactly aligned during movement.
 */
export class ThreeTacticalLayer implements CustomLayerInterface {
  readonly id = THREE_TACTICAL_LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map?: MlMap;
  private scene?: Scene;
  private camera?: Camera;
  private renderer?: WebGLRenderer;
  private root?: Group;
  private sources: MapSources;
  private screenSpaceObjects: ScreenSpaceObject[] = [];
  private pulses: Pulse[] = [];
  private reducedMotion = false;

  constructor(sources: MapSources) {
    this.sources = sources;
  }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.scene = new Scene();
    this.camera = new Camera();
    this.renderer = new WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true
    });
    this.renderer.autoClear = false;
    this.reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.rebuildScene();
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.map || !this.scene || !this.camera || !this.renderer) return;

    this.camera.projectionMatrix.fromArray(options.modelViewProjectionMatrix);
    const mercatorPerPixel = 1 / (TILE_SIZE * 2 ** this.map.getZoom());
    for (const entry of this.screenSpaceObjects) {
      const scale = mercatorPerPixel * entry.pixels;
      entry.object.scale.set(scale, scale, scale);
    }

    if (this.pulses.length > 0) {
      const pulse = this.reducedMotion ? 0 : (Math.sin(performance.now() / 420) + 1) / 2;
      for (const entry of this.pulses) {
        const scale = mercatorPerPixel * entry.pixels * (1 + pulse * 0.34);
        entry.object.scale.set(scale, scale, scale);
        entry.material.opacity = 0.5 - pulse * 0.28;
      }
      if (!this.reducedMotion) this.map.triggerRepaint();
    }

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.renderer.resetState();
  }

  onRemove(): void {
    this.disposeRoot();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.camera = undefined;
    this.scene = undefined;
    this.map = undefined;
  }

  updateSources(sources: MapSources): void {
    this.sources = sources;
    if (this.scene) this.rebuildScene();
    this.map?.triggerRepaint();
  }

  private rebuildScene(): void {
    if (!this.scene) return;
    this.disposeRoot();
    this.screenSpaceObjects = [];
    this.pulses = [];
    this.root = new Group();
    this.root.renderOrder = 20;
    this.scene.add(this.root);

    for (const feature of this.sources.geofeatures.features) this.addGeofeature(feature);
    for (const feature of this.sources.assets.features) this.addPointSignal(feature);
    for (const feature of this.sources.tracks.features) this.addPointSignal(feature);
  }

  private addPointSignal(feature: MapFeature): void {
    if (!this.root || feature.geometry.type !== "Point") return;
    const coordinates = feature.geometry.coordinates;
    if (!isPosition(coordinates)) return;

    const group = new Group();
    const point = mercatorPoint(coordinates[0], coordinates[1]);
    group.position.set(point.x, point.y, 0);
    const color = featureColor(feature);

    const haloMaterial = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: feature.properties.kind === "asset" ? 0.26 : 0.2,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide
    });
    const halo = new Mesh(new RingGeometry(0.76, 1, 48), haloMaterial);
    halo.renderOrder = 21;
    group.add(halo);

    const ticks = new LineSegments(
      new BufferGeometry().setFromPoints([
        new Vector3(-1.18, 0, 0),
        new Vector3(-0.92, 0, 0),
        new Vector3(0.92, 0, 0),
        new Vector3(1.18, 0, 0),
        new Vector3(0, -1.18, 0),
        new Vector3(0, -0.92, 0),
        new Vector3(0, 0.92, 0),
        new Vector3(0, 1.18, 0)
      ]),
      this.lineMaterial(color, 0.72)
    );
    ticks.renderOrder = 21;
    group.add(ticks);

    if (feature.properties.kind === "asset" && feature.properties.heading !== undefined) {
      const radians = (feature.properties.heading * Math.PI) / 180;
      const heading = new Line(
        new BufferGeometry().setFromPoints([
          new Vector3(0, 0, 0),
          new Vector3(Math.sin(radians) * 1.72, -Math.cos(radians) * 1.72, 0)
        ]),
        this.lineMaterial(color, 0.88)
      );
      heading.renderOrder = 22;
      group.add(heading);
    }

    const pixels = feature.properties.selected ? 26 : 20;
    this.screenSpaceObjects.push({ object: group, pixels });
    if (feature.properties.selected) {
      const pulseMaterial = new MeshBasicMaterial({
        color: COLORS.selected,
        transparent: true,
        opacity: 0.42,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide
      });
      const pulse = new Mesh(new RingGeometry(1.16, 1.22, 56), pulseMaterial);
      pulse.position.copy(group.position);
      pulse.renderOrder = 23;
      this.root.add(pulse);
      this.pulses.push({ object: pulse, material: pulseMaterial, pixels });
    }

    this.root.add(group);
  }

  private addGeofeature(feature: MapFeature): void {
    if (!this.root) return;
    const color = feature.properties.selected ? COLORS.selected : featureColor(feature);
    const geometry = feature.geometry;

    if (geometry.type === "Point" && isPosition(geometry.coordinates)) {
      const point = mercatorPoint(geometry.coordinates[0], geometry.coordinates[1]);
      const group = new Group();
      group.position.set(point.x, point.y, 0);
      const material = new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.82,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide
      });
      group.add(new Mesh(new CircleGeometry(1, 32), material));
      this.screenSpaceObjects.push({ object: group, pixels: feature.properties.selected ? 8 : 6 });
      this.root.add(group);
      return;
    }

    if (geometry.type === "LineString") {
      this.addLine(geometry.coordinates, color, feature.properties.selected, false);
      return;
    }

    if (geometry.type !== "Polygon") return;
    for (const polygon of renderablePolygons(geometry.coordinates)) {
      const [outer, ...holes] = polygon;
      if (!outer || outer.length < 3) continue;
      const shape = this.shapeFromRing(outer);
      for (const hole of holes) {
        if (hole.length >= 3) shape.holes.push(this.pathFromRing(hole));
      }
      const material = new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: feature.properties.selected ? 0.25 : 0.14,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide
      });
      const mesh = new Mesh(new ShapeGeometry(shape), material);
      mesh.renderOrder = 20;
      this.root.add(mesh);
      this.addLine(outer, color, feature.properties.selected, true);
      for (const hole of holes) this.addLine(hole, color, feature.properties.selected, true);
    }
  }

  private addLine(coordinates: unknown, color: number, selected: boolean, loop: boolean): void {
    if (!this.root || !Array.isArray(coordinates)) return;
    const points = coordinates.flatMap((coordinate) => {
      if (!isPosition(coordinate)) return [];
      const point = mercatorPoint(coordinate[0], coordinate[1]);
      return [new Vector3(point.x, point.y, 0)];
    });
    if (points.length < 2) return;
    const geometry = new BufferGeometry().setFromPoints(points);
    const material = this.lineMaterial(color, selected ? 1 : 0.78);
    const line = loop ? new LineLoop(geometry, material) : new Line(geometry, material);
    line.renderOrder = 22;
    this.root.add(line);
  }

  private shapeFromRing(ring: unknown[]) {
    const shape = new Shape();
    for (const [index, coordinate] of ring.entries()) {
      if (!isPosition(coordinate)) continue;
      const point = mercatorPoint(coordinate[0], coordinate[1]);
      if (index === 0) shape.moveTo(point.x, point.y);
      else shape.lineTo(point.x, point.y);
    }
    return shape;
  }

  private pathFromRing(ring: unknown[]) {
    const path = new Path();
    for (const [index, coordinate] of ring.entries()) {
      if (!isPosition(coordinate)) continue;
      const point = mercatorPoint(coordinate[0], coordinate[1]);
      if (index === 0) path.moveTo(point.x, point.y);
      else path.lineTo(point.x, point.y);
    }
    return path;
  }

  private lineMaterial(color: number, opacity: number): LineBasicMaterial {
    return new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
  }

  private disposeRoot(): void {
    if (!this.root) return;
    this.scene?.remove(this.root);
    this.root.traverse((object) => {
      const renderable = object as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
      renderable.geometry?.dispose();
      if (Array.isArray(renderable.material)) {
        for (const material of renderable.material) material.dispose();
      } else {
        renderable.material?.dispose();
      }
    });
    this.root = undefined;
  }
}

export function mercatorPoint(longitude: number, latitude: number): { x: number; y: number } {
  const clampedLatitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  const latitudeRadians = (clampedLatitude * Math.PI) / 180;
  return {
    x: (longitude + 180) / 360,
    y: (1 - Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) / Math.PI) / 2
  };
}

function featureColor(feature: MapFeature): number {
  const classification = feature.properties.classification?.toLowerCase();
  if (classification === "hostile" || classification === "suspect") return COLORS.hostile;
  return COLORS[feature.properties.kind];
}

function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

// ShapeGeometry is planar, so unwrap antimeridian-crossing rings into a short
// path and render a shifted copy for the opposite edge of the Mercator world.
function renderablePolygons(coordinates: unknown): unknown[][][] {
  if (!Array.isArray(coordinates)) return [];
  const rings = coordinates.filter(Array.isArray) as unknown[][];
  const crosses = rings.some((ring) => {
    const longitudes = ring.flatMap((position) => (isPosition(position) ? [position[0]] : []));
    return longitudes.length > 1 && Math.max(...longitudes) - Math.min(...longitudes) > 180;
  });
  if (!crosses) return [rings];

  const anchor = rings[0]?.find(isPosition)?.[0];
  if (anchor === undefined) return [];
  const unwrapped = rings.map((ring) =>
    ring.map((position) => {
      if (!isPosition(position)) return position;
      let longitude = position[0];
      while (longitude - anchor > 180) longitude -= 360;
      while (longitude - anchor < -180) longitude += 360;
      return [longitude, position[1]];
    })
  );
  const shift = anchor >= 0 ? -360 : 360;
  const oppositeEdge = unwrapped.map((ring) =>
    ring.map((position) => (isPosition(position) ? [position[0] + shift, position[1]] : position))
  );
  return [unwrapped, oppositeEdge];
}
