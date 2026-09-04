import { describe, expect, it } from "vitest";
import {
  localDeleteEvent,
  matchesSubscription,
  resourceCacheKey,
  resourceID,
  resourceUpsertEvent,
  subscriptionKey,
  subscriptionMessage
} from "../src/subscriptions.js";
import { entity, task } from "./support/fake-core.js";

describe("subscription and resource identity boundaries", () => {
  it("normalizes caller-supplied IDs", () => {
    const filter = { filter: "id", resource_type: "entity", id: " asset-1 " } as const;

    expect(subscriptionMessage("subscribe", filter)).toEqual({
      action: "subscribe",
      filter: "id",
      resource_type: "entity",
      id: "asset-1"
    });
    expect(subscriptionKey(filter)).toBe('["id","entity","asset-1"]');
  });

  it("keeps inbound resource IDs raw and rejects a padded resource mismatch", () => {
    const resource = entity(" asset-1 ");

    expect(resourceID("entity", resource)).toBe(" asset-1 ");
    expect(() => resourceUpsertEvent("entity", "create", "asset-1", 1, resource)).toThrow(
      "Atlas entity resource id  asset-1  does not match event id asset-1"
    );
  });

  it("does not match subscriptions against padded inbound IDs", () => {
    const entityEvent = {
      event: "create",
      resource_type: "entity",
      id: " asset-1 ",
      version: 1,
      resource: entity("asset-1")
    } as const;
    const taskEvent = {
      event: "create",
      resource_type: "task",
      id: "task-1",
      version: 1,
      resource: task("task-1", " asset-1 ")
    } as const;

    expect(matchesSubscription({ filter: "id", resource_type: "entity", id: "asset-1" }, entityEvent)).toBe(false);
    expect(matchesSubscription({ filter: "tasks_for_asset", asset_id: "asset-1" }, taskEvent)).toBe(false);
  });

  it("rejects padded IDs at the inbound cache-key boundary", () => {
    expect(resourceCacheKey("entity", "asset-1")).toBe('["entity","asset-1"]');
    expect(() => resourceCacheKey("entity", " asset-1 ")).toThrow("Atlas entity_id must be canonical");
  });

  it("accepts canonical inbound IDs", () => {
    const resource = entity("asset-1");
    const event = {
      event: "create",
      resource_type: "entity",
      id: "asset-1",
      version: 1,
      resource
    } as const;

    expect(resourceID("entity", resource)).toBe("asset-1");
    expect(matchesSubscription({ filter: "id", resource_type: "entity", id: " asset-1 " }, event)).toBe(true);
    expect(localDeleteEvent("entity", "asset-1", 1).id).toBe("asset-1");
    expect(resourceUpsertEvent("entity", "create", "asset-1", 1, resource)).toMatchObject({
      id: "asset-1",
      resource
    });
  });
});
