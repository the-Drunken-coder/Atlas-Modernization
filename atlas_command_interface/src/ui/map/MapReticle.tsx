import type { CSSProperties } from "react";
import type { ReticleState } from "./map-reticle.js";

type MapReticleProps = {
  reticle: ReticleState;
  scrolling?: boolean;
  zooming?: boolean;
};

export function MapReticle({ reticle, scrolling = false, zooming = false }: MapReticleProps) {
  const style = {
    "--map-reticle-x": `${reticle.x}px`,
    "--map-reticle-y": `${reticle.y}px`,
    "--map-reticle-target-height": `${reticle.target.height}px`,
    "--map-reticle-target-width": `${reticle.target.width}px`,
    "--map-reticle-target-x": `${reticle.target.x}px`,
    "--map-reticle-target-y": `${reticle.target.y}px`
  } as CSSProperties;
  const className = [
    "map-reticle",
    scrolling ? "map-reticle--scrolling" : "",
    zooming ? "map-reticle--zoom" : "",
    !zooming && reticle.targeted ? "map-reticle--targeted" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} style={style} aria-hidden="true">
      <div className="map-reticle__line map-reticle__line--left" />
      <div className="map-reticle__line map-reticle__line--right" />
      <div className="map-reticle__line map-reticle__line--top" />
      <div className="map-reticle__line map-reticle__line--bottom" />
      <div className="map-reticle__target" />
    </div>
  );
}
