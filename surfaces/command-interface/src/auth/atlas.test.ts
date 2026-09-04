import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATLAS_AUTH_EXPIRED_EVENT,
  createAuthenticatedAtlasAdminClient,
  createUnauthenticatedAtlasAdminClient,
  expireAuthSession,
  rotateAuthSession
} from "./atlas.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Atlas authenticated transport", () => {
  it("shares credentials and session-expiry payload handling across admin clients", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.credentials).toBe("include");
        return Response.json(
          { success: false, error_code: "UNAUTHORIZED", message: "Login is required" },
          { status: 401 }
        );
      })
    );
    rotateAuthSession();

    await expect(createAuthenticatedAtlasAdminClient("https://core.test").apiKeys.list()).rejects.toMatchObject({
      status: 401,
      errorCode: "UNAUTHORIZED"
    });

    await vi.waitFor(() =>
      expect(dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ATLAS_AUTH_EXPIRED_EVENT,
          detail: expect.objectContaining({ session: expect.any(Number) })
        })
      )
    );
  });

  it("does not hold the SDK response open while inspecting an expiry payload", async () => {
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    const response = Response.json(
      { success: false, error_code: "UNAUTHORIZED", message: "Login is required" },
      { status: 401 }
    );
    const hangingClone = response.clone();
    vi.spyOn(hangingClone, "json").mockImplementation(() => new Promise<never>(() => {}));
    vi.spyOn(response, "clone").mockReturnValue(hangingClone);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response)
    );
    rotateAuthSession();
    let settled = false;

    const request = createAuthenticatedAtlasAdminClient("https://core.test")
      .apiKeys.list()
      .catch((error: unknown) => {
        settled = true;
        return error;
      });

    await vi.waitFor(() => expect(settled).toBe(true));
    await expect(request).resolves.toMatchObject({ status: 401, errorCode: "UNAUTHORIZED" });
  });

  it("does not report session-check or login 401 responses as expiry", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: false, error_code: "UNAUTHORIZED" }, { status: 401 }))
    );

    await expect(createUnauthenticatedAtlasAdminClient("https://core.test").auth.me()).rejects.toMatchObject({
      status: 401,
      errorCode: "UNAUTHORIZED"
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("ignores a 401 from an old client after a newer session is established", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending)
    );

    const oldSession = rotateAuthSession();
    const oldRequest = createAuthenticatedAtlasAdminClient("https://core.test").apiKeys.list();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    rotateAuthSession();
    release(Response.json({ success: false, error_code: "UNAUTHORIZED" }, { status: 401 }));

    await expect(oldRequest).rejects.toMatchObject({ status: 401, errorCode: "UNAUTHORIZED" });
    expect(expireAuthSession(oldSession)).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
