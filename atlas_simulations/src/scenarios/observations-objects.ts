import type { Scenario } from "../server/scenario.js";
import { isoNow, jsonObject, numberInput, point } from "./helpers.js";

const observationsObjects: Scenario = {
  id: "observations-objects",
  name: "Observations and objects",
  summary: "Creates observing assets, tracks, and object metadata linked to observations.",
  acceptsJson: true,
  inputFields: [
    { key: "assetCount", label: "Asset count", type: "number", defaultValue: 2, min: 1, max: 10, step: 1 },
    { key: "observations", label: "Observations", type: "number", defaultValue: 4, min: 1, max: 50, step: 1 },
    { key: "tickMs", label: "Tick ms", type: "number", defaultValue: 200, min: 0, max: 10000, step: 50 },
    { key: "startLatitude", label: "Start latitude", type: "number", defaultValue: 38.88, min: -90, max: 89.9557, step: 0.0001 },
    { key: "startLongitude", label: "Start longitude", type: "number", defaultValue: -77.04, min: -180, max: 179.9459, step: 0.0001 }
  ],
  async run(ctx, input) {
    const assetCount = numberInput(input, "assetCount");
    const observations = numberInput(input, "observations");
    const tickMs = numberInput(input, "tickMs");
    const startLatitude = numberInput(input, "startLatitude");
    const startLongitude = numberInput(input, "startLongitude");
    const extra = jsonObject(input);
    const assetIds: string[] = [];
    const trackIds: string[] = [];
    const objectIds: string[] = [];

    for (let index = 0; index < assetCount; index++) {
      if (ctx.signal.aborted) throw new Error("Simulation cancelled");
      const id = ctx.id(`observer-${index + 1}`);
      assetIds.push(id);
      await ctx.createEntity({
        entity_id: id,
        entity_type: "asset",
        alias: `Observer ${index + 1}`,
        subtype: "simulated-observer",
        components: {
          telemetry: {
            latitude: startLatitude + index * 0.001,
            longitude: startLongitude + index * 0.001,
            heading_deg: 90,
            speed_m_s: 4,
            last_update: isoNow()
          },
          geometry: point(startLongitude + index * 0.001, startLatitude + index * 0.001),
          heartbeat: { last_seen: isoNow() },
          status: { value: "observing", last_update: isoNow() },
          sensor_refs: [{ sensor_id: `${id}-camera`, type: "camera", horizontal_fov: 60 }],
          custom_simulation: { ...extra, run_id: ctx.runId }
        }
      });
      if (ctx.signal.aborted) throw new Error("Simulation cancelled");
    }

    for (let index = 0; index < observations; index++) {
      if (ctx.signal.aborted) throw new Error("Simulation cancelled");
      const observerId = assetIds[index % assetIds.length];
      const trackId = ctx.id(`track-${index + 1}`);
      const objectId = ctx.id(`observation-object-${index + 1}`);
      const latitude = startLatitude + 0.01 + index * 0.0007;
      const longitude = startLongitude + 0.01 + index * 0.0009;
      trackIds.push(trackId);
      objectIds.push(objectId);

      await ctx.createEntity({
        entity_id: trackId,
        entity_type: "track",
        alias: `Observed track ${index + 1}`,
        subtype: "simulated-observation",
        components: {
          telemetry: { latitude, longitude, last_update: isoNow() },
          geometry: point(longitude, latitude),
          mil_view: { classification: index % 2 === 0 ? "unknown" : "neutral", last_seen: isoNow() },
          status: { value: "observed", last_update: isoNow() },
          custom_simulation: {
            ...extra,
            run_id: ctx.runId,
            observer_id: observerId,
            observation_index: index + 1
          }
        }
      });

      if (ctx.signal.aborted) throw new Error("Simulation cancelled");
      await ctx.createObject({
        object_id: objectId,
        type: "observation",
        content_type: "application/json",
        size_bytes: 256 + index,
        usage_hints: ["thumbnail"],
        referenced_by: [{ entity_id: trackId }]
      });
      if (ctx.signal.aborted) throw new Error("Simulation cancelled");
      ctx.log(`Observation ${index + 1} linked ${observerId} to ${trackId}`);
      if (index < observations - 1) await ctx.wait(tickMs);
    }

    const observerResults = await Promise.allSettled(assetIds.map((id) => ctx.client.entities.get(id)));
    const trackResults = await Promise.allSettled(trackIds.map((id) => ctx.client.entities.get(id)));
    const objectResults = await Promise.allSettled(objectIds.map((id) => ctx.client.objects.get(id)));
    const persistedObservers = fulfilledValues(observerResults);
    const persistedTracks = fulfilledValues(trackResults);
    const persistedObjects = fulfilledValues(objectResults);
    ctx.assert("Observer assets persisted", persistedObservers.length === assetCount, `${persistedObservers.length}/${assetCount} observers persisted`);
    ctx.assert(
      "Tracks persisted",
      persistedTracks.length === observations && persistedTracks.every((track) => track.entity_type === "track"),
      `${persistedTracks.length}/${observations} tracks persisted`
    );
    ctx.assert(
      "Object references persisted",
      persistedObjects.length === observations &&
        persistedObjects.every((object, index) => (object.referenced_by ?? []).some((reference) => reference.entity_id === trackIds[index])),
      `${persistedObjects.length}/${observations} objects linked`
    );
    throwFirstRejected([...observerResults, ...trackResults, ...objectResults]);
  }
};

export default observationsObjects;

function fulfilledValues<T>(results: Array<PromiseSettledResult<T>>): T[] {
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

function throwFirstRejected(results: Array<PromiseSettledResult<unknown>>): void {
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
}
