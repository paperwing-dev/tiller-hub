import type { WorkspaceHost } from "agents/experimental/workspace";

interface DOContext {
  storage: { sql: SqlStorage };
  id: DurableObjectId;
}

export function createWorkspaceHost(ctx: DOContext): WorkspaceHost {
  return {
    sql<T = Record<string, string | number | boolean | null>>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ): T[] {
      const query = strings.reduce(
        (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
        "",
      );
      return [...ctx.storage.sql.exec(query, ...values)] as T[];
    },
    get name() {
      return ctx.id.toString();
    },
  };
}
