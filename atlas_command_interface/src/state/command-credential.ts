import { useState } from "react";

/**
 * The command API key the operator must present to /api/commands. It is held
 * only in React state for the current browser session and never persisted or
 * embedded at build time.
 */
export function useCommandCredential(): { credential: string; setCredential: (value: string) => void } {
  const [credential, setCredential] = useState("");
  return { credential, setCredential };
}
