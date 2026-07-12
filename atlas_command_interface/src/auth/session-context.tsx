import { createContext, useContext, type ReactNode } from "react";

export type AuthenticatedSession = {
  username: string;
  loggingOut: boolean;
  error?: string;
  logout: () => Promise<void>;
};

const AuthenticatedSessionContext = createContext<AuthenticatedSession | null>(null);

export function AuthenticatedSessionProvider({ children, value }: { children: ReactNode; value: AuthenticatedSession }) {
  return <AuthenticatedSessionContext.Provider value={value}>{children}</AuthenticatedSessionContext.Provider>;
}

export function useAuthenticatedSession(): AuthenticatedSession | null {
  return useContext(AuthenticatedSessionContext);
}
