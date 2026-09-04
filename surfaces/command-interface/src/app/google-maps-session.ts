const SESSION_TIMEOUT_MS = 10_000;

export function fetchGoogleMapsTileSession(apiKey: string): Promise<string | undefined> {
  const controller = new AbortController();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      controller.abort();
      console.warn("Google Maps satellite session request unavailable", `timed out after ${SESSION_TIMEOUT_MS}ms`);
      resolve(undefined);
    }, SESSION_TIMEOUT_MS);
    void fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US" }),
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) {
          console.warn("Google Maps satellite session request unavailable");
          return undefined;
        }
        const payload = (await response.json().catch(() => undefined)) as { session?: unknown } | undefined;
        const session = typeof payload?.session === "string" ? payload.session.trim() : "";
        if (!session) console.warn("Google Maps satellite session request unavailable");
        return session || undefined;
      })
      .then(
        (session) => {
          clearTimeout(timeout);
          resolve(session);
        },
        () => {
          clearTimeout(timeout);
          if (!controller.signal.aborted) console.warn("Google Maps satellite session request unavailable");
          resolve(undefined);
        }
      );
  });
}
