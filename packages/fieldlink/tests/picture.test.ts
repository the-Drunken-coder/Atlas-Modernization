import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import type { ObservationMessage } from "../src/messages/observation.js";
import { attachFieldLinkPicture, FieldLinkPicture } from "../src/picture.js";
import { parseNodeId, type ReceivedMessage } from "../src/node.js";

describe("FieldLink Picture", () => {
  it("persists latest state, bounds its journal, and marks stale records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fieldlink-picture-"));
    const path = join(directory, "picture.json");
    try {
      const picture = await FieldLinkPicture.open({
        path,
        maximumJournalEntries: 2,
        staleAfterMs: 5 * 60 * 1000,
        now: () => Date.parse("2026-08-26T12:10:00.000Z"),
      });
      const first = observation("track-1-v1", "track", "track-1", "12:00", {
        latitude: 1,
      });
      const latest = observation("track-1-v2", "track", "track-1", "12:02", {
        latitude: 2,
      });
      const feature = observation(
        "feature-1-v1",
        "geofeature",
        "feature-1",
        "12:09",
        { geometry: { type: "Point", coordinates: [1, 2] } },
      );

      await expect(picture.record(received(first))).resolves.toBe(true);
      await expect(picture.record(received(latest))).resolves.toBe(true);
      await expect(picture.record(received(feature))).resolves.toBe(true);
      await expect(picture.record(received(latest))).resolves.toBe(false);

      expect(picture.journal().map((record) => record.observationId)).toEqual([
        "track-1-v2",
        "feature-1-v1",
      ]);
      expect(picture.latest("track", "track-1")).toMatchObject({
        observationId: "track-1-v2",
        body: { latitude: 2 },
        stale: true,
        authentication: "unverified",
      });
      expect(picture.latest("geofeature", "feature-1")).toMatchObject({
        stale: false,
      });
      await picture.close();

      const reopened = await FieldLinkPicture.open({
        path,
        maximumJournalEntries: 2,
      });
      expect(reopened.list()).toHaveLength(2);
      expect(reopened.latest("track", "track-1")?.body).toEqual({
        latitude: 2,
      });
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("attaches to addressed and passive streams without duplicate records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fieldlink-picture-"));
    try {
      const picture = await FieldLinkPicture.open({
        path: join(directory, "picture.json"),
      });
      const node = new PictureNodeProbe();
      const detach = attachFieldLinkPicture(node, picture);
      const message = received(
        observation("entity-1-v1", "entity", "entity-1", "12:00", {
          status: "online",
        }),
      );

      await node.addressed(message);
      await node.passive(message);

      expect(picture.journal()).toHaveLength(1);
      detach();
      await picture.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds latest state, replay keys, journal entries, and stored bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fieldlink-picture-"));
    const path = join(directory, "picture.json");
    try {
      const picture = await FieldLinkPicture.open({
        path,
        maximumJournalEntries: 2,
        maximumLatestEntries: 2,
        maximumSeenEntries: 2,
        maximumStoredBytes: 4_000,
      });
      for (let index = 0; index < 5; index += 1) {
        await picture.record(
          received(
            observation(
              `track-${index}-v1`,
              "track",
              `track-${index}`,
              `12:0${index}`,
              { payload: "x".repeat(200) },
            ),
          ),
        );
      }
      await picture.close();

      expect(picture.list()).toHaveLength(2);
      expect(picture.journal()).toHaveLength(2);
      expect((await stat(path)).size).toBeLessThanOrEqual(4_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("scopes replay detection by source and resolves equal timestamps deterministically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fieldlink-picture-"));
    try {
      const picture = await FieldLinkPicture.open({
        path: join(directory, "picture.json"),
      });
      const earlierId = observation(
        "observation-a",
        "track",
        "track-1",
        "12:00",
        { latitude: 1 },
      );
      const laterId = observation(
        "observation-z",
        "track",
        "track-1",
        "12:00",
        { latitude: 2 },
      );

      await expect(picture.record(received(laterId))).resolves.toBe(true);
      await expect(picture.record(received(earlierId))).resolves.toBe(true);
      await expect(
        picture.record(received(earlierId, "cccccccccccccccc")),
      ).resolves.toBe(true);

      expect(picture.latest("track", "track-1")).toMatchObject({
        observationId: "observation-z",
        body: { latitude: 2 },
      });
      expect(picture.journal()).toHaveLength(3);
      await picture.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers persistence after a transient filesystem failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fieldlink-picture-"));
    const blocked = join(directory, "blocked");
    const path = join(blocked, "picture.json");
    try {
      const picture = await FieldLinkPicture.open({ path });
      await writeFile(blocked, "not a directory", "utf8");
      await expect(
        picture.record(
          received(
            observation("track-1-v1", "track", "track-1", "12:00", {
              latitude: 1,
            }),
          ),
        ),
      ).rejects.toThrow();

      await unlink(blocked);
      await mkdir(blocked);
      await expect(picture.close()).resolves.toBeUndefined();
      expect((await stat(path)).size).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class PictureNodeProbe {
  #addressed: ((message: ReceivedMessage) => void | Promise<void>) | undefined;
  #passive: ((message: ReceivedMessage) => void | Promise<void>) | undefined;

  onMessage(
    listener: (message: ReceivedMessage) => void | Promise<void>,
  ): () => void {
    this.#addressed = listener;
    return () => {
      this.#addressed = undefined;
    };
  }

  onPassiveMessage(
    listener: (message: ReceivedMessage) => void | Promise<void>,
  ): () => void {
    this.#passive = listener;
    return () => {
      this.#passive = undefined;
    };
  }

  async addressed(message: ReceivedMessage): Promise<void> {
    await this.#addressed?.(message);
  }

  async passive(message: ReceivedMessage): Promise<void> {
    await this.#passive?.(message);
  }
}

function observation(
  observationId: string,
  resourceType: ObservationMessage["resource_type"],
  resourceId: string,
  time: string,
  body: ObservationMessage["body"],
): ObservationMessage {
  return {
    type: "observation",
    observation_id: observationId,
    observed_at: `2026-08-26T${time}:00.000Z`,
    resource_type: resourceType,
    resource_id: resourceId,
    body,
  };
}

function received(
  message: ObservationMessage,
  source = "aaaaaaaaaaaaaaaa",
): ReceivedMessage {
  return {
    message,
    source: parseNodeId(source),
    destination: parseNodeId("0000000000000000"),
    logicalId: "0000000000000001",
    delivery: "transfer",
    receivedAt: new Date("2026-08-26T12:10:00.000Z"),
    snrDb: -7,
  };
}
