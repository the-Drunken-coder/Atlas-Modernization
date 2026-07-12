import { formatCoordinate } from "../../atlas/geometry.js";
import { formatImperialDistance, tetherSegment, type CursorOverlayState } from "./map-cursor-overlay.js";

export function MapCursorOverlay({ point, coordinates, selection, distanceMeters, bearingDegrees }: CursorOverlayState) {
  const tether = selection ? tetherSegment(selection.target, point) : null;
  return (
    <>
      {selection ? (
        <svg className="map-cursor-locator" aria-hidden="true">
          {tether ? <line className="map-cursor-locator__tether" x1={tether.start.x} y1={tether.start.y} x2={tether.end.x} y2={tether.end.y} /> : null}
          <path
            className="map-cursor-locator__x"
            d={`M ${point.x - 5} ${point.y - 5} L ${point.x + 5} ${point.y + 5} M ${point.x + 5} ${point.y - 5} L ${point.x - 5} ${point.y + 5}`}
          />
        </svg>
      ) : null}
      <div className="map-cursor-readout" data-testid="map-cursor-readout">
        <span>CURSOR&nbsp; {formatCoordinate([coordinates.lng, coordinates.lat])}</span>
        {distanceMeters !== undefined ? <span>RANGE&nbsp; {formatImperialDistance(distanceMeters)}</span> : null}
        {bearingDegrees !== undefined ? <span>BEARING&nbsp; {Math.round(bearingDegrees) % 360}°</span> : null}
      </div>
    </>
  );
}
