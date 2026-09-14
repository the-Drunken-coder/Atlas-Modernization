import { appendFileSync } from "node:fs";

/** Routes the browser's real Core feed so acceptance can sever and restore only browser transport. */
export async function createFeedTransportGate(
  context,
  { coreOrigin, logPath },
) {
  const coreHost = new URL(coreOrigin).host;
  const connections = new Map();
  let nextConnectionID = 1;
  let severed = false;
  let forwardedConnections = 0;
  let blockedConnections = 0;
  let closedConnections = 0;

  await context.routeWebSocket(
    (url) => url.host === coreHost && url.pathname === "/feed",
    (browserSocket) => {
      const connectionID = nextConnectionID++;
      if (severed) {
        blockedConnections += 1;
        appendJSON(logPath, {
          timestamp: new Date().toISOString(),
          event: "blocked",
          connection_id: connectionID,
          url: browserSocket.url(),
        });
        void browserSocket.close({
          code: 1012,
          reason: "acceptance transport severed",
        });
        return;
      }

      const serverSocket = browserSocket.connectToServer();
      forwardedConnections += 1;
      connections.set(connectionID, {
        browserSocket,
        serverSocket,
        closed: false,
      });
      appendJSON(logPath, {
        timestamp: new Date().toISOString(),
        event: "forwarding",
        connection_id: connectionID,
        url: browserSocket.url(),
      });
    },
  );

  const snapshot = () => ({
    severed,
    forwarded_connections: forwardedConnections,
    blocked_connections: blockedConnections,
    closed_connections: closedConnections,
  });

  return {
    snapshot,

    async sever() {
      severed = true;
      const active = [...connections.entries()].filter(
        ([, connection]) => !connection.closed,
      );
      for (const [connectionID, connection] of active) {
        connection.closed = true;
        closedConnections += 1;
        appendJSON(logPath, {
          timestamp: new Date().toISOString(),
          event: "severed",
          connection_id: connectionID,
          url: connection.browserSocket.url(),
        });
      }
      await Promise.allSettled(
        active.map(([, connection]) =>
          connection.browserSocket.close({
            code: 1012,
            reason: "acceptance transport severed",
          }),
        ),
      );
      return snapshot();
    },

    restore() {
      severed = false;
      appendJSON(logPath, {
        timestamp: new Date().toISOString(),
        event: "restored",
      });
      return snapshot();
    },
  };
}

function appendJSON(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}
