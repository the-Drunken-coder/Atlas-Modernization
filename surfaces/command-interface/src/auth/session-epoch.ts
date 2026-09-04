const sessionChangedEvent = "atlas-auth-session-changed";

let authSessionEpoch = 0;
let authSessionEventTarget: Window | undefined;

export function getAuthSessionEpoch(): number {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    if (authSessionEventTarget !== window) {
      authSessionEventTarget?.removeEventListener(sessionChangedEvent, advanceAuthSessionEpoch);
      window.addEventListener(sessionChangedEvent, advanceAuthSessionEpoch);
      authSessionEventTarget = window;
    }
  }
  return authSessionEpoch;
}

export function isCurrentAuthSessionEpoch(epoch: number): boolean {
  return getAuthSessionEpoch() === epoch;
}

export function notifyAuthSessionChanged(): void {
  window.dispatchEvent(new Event(sessionChangedEvent));
}

function advanceAuthSessionEpoch(): void {
  authSessionEpoch++;
}
