import { jsonSchema, tool, type ToolSet } from "ai";
import type { WorkspaceContextAccess, WorkspaceEntry } from "./types";

function getInputString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function requiredInputString(input: unknown, key: string): string {
  const value = getInputString(input, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function formatFileInfo(entry: WorkspaceEntry): string {
  return `${entry.type === "directory" ? "d" : "f"} ${entry.path} (${entry.size}b)`;
}

export function createReviewerTools(workspace: WorkspaceContextAccess): ToolSet {
  return {
    read_file: tool({
      description: "Read the contents of a file at the given path.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path starting with /" },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const path = requiredInputString(input, "path");
        const content = await workspace.readFile(path);
        if (content == null) throw new Error(`File not found at ${path}`);
        return content;
      },
    }),
    list_files: tool({
      description: "List files and directories in the given directory.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory path (default: /)" },
        },
        required: [],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const directory = getInputString(input, "directory") || "/";
        const entries = await workspace.readDir(directory);
        return entries.map(formatFileInfo).join("\n") || "(empty directory)";
      },
    }),
    glob: tool({
      description: "Find files matching a glob pattern (e.g. **/*.ts, src/**/*.tsx).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
        },
        required: ["pattern"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const pattern = requiredInputString(input, "pattern");
        const matches = await workspace.glob(pattern);
        return matches.map(formatFileInfo).join("\n") || "(no matches)";
      },
    }),
  };
}
