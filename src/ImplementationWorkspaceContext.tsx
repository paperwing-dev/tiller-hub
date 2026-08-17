import { createContext, useContext, type ReactNode } from "react";

export interface ImplementationWorkspaceContextValue {
  selectedEnvSlug: string | null;
  implementationName: string | null;
}

const ImplementationWorkspaceContext = createContext<ImplementationWorkspaceContextValue | null>(null);

export function ImplementationWorkspaceProvider({
  value,
  children,
}: {
  value: ImplementationWorkspaceContextValue;
  children: ReactNode;
}) {
  return (
    <ImplementationWorkspaceContext.Provider value={value}>
      {children}
    </ImplementationWorkspaceContext.Provider>
  );
}

export function useImplementationWorkspaceContext(): ImplementationWorkspaceContextValue | null {
  return useContext(ImplementationWorkspaceContext);
}
