import { useCallback, useState } from "react";

const STORAGE_KEY = "atlas.commandApiKey";

function read(): string {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function write(value: string): void {
  try {
    if (value) {
      globalThis.localStorage?.setItem(STORAGE_KEY, value);
    } else {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, disabled storage, etc.).
  }
}

/**
 * The command API key the operator must present to /api/commands. Persisted to
 * localStorage so it survives reloads; it is never embedded at build time.
 */
export function useCommandCredential(): { credential: string; setCredential: (value: string) => void } {
  const [credential, setCredentialState] = useState<string>(read);
  const setCredential = useCallback((value: string) => {
    setCredentialState(value);
    write(value);
  }, []);
  return { credential, setCredential };
}
