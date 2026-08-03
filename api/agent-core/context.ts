import type { ReviewerAgentSpec, WorkspaceContextAccess, WorkspaceEntry } from "./types";

const PROJECT_CONTEXT_PATHS = ["/.tiller/CLAUDE.md", "/CLAUDE.md"];

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n...(truncated)` : text;
}

async function readOptionalFile(workspace: WorkspaceContextAccess, path: string): Promise<string | null> {
  try {
    return await workspace.readFile(path);
  } catch {
    return null;
  }
}

async function readOptionalDir(workspace: WorkspaceContextAccess, path: string): Promise<WorkspaceEntry[]> {
  try {
    return await workspace.readDir(path);
  } catch {
    return [];
  }
}

async function buildWorkspaceSummary(workspace: WorkspaceContextAccess): Promise<string> {
  const info = await workspace.getWorkspaceInfo();
  const topLevel = (await readOptionalDir(workspace, "/"))
    .slice(0, 20)
    .map((entry) => `${entry.type === "directory" ? "d" : "f"} ${entry.path}`)
    .join("\n");

  return [
    `Files: ${info.fileCount}`,
    `Directories: ${info.directoryCount}`,
    `Bytes: ${info.totalBytes}`,
    topLevel ? `Top level:\n${topLevel}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function buildSystemPrompt(
  spec: ReviewerAgentSpec,
  workspace: WorkspaceContextAccess,
): Promise<string> {
  const sections = [
    spec.baseInstructions,
    `<workspace-summary>\n${truncateText(await buildWorkspaceSummary(workspace), 2_000)}\n</workspace-summary>`,
  ];

  for (const path of PROJECT_CONTEXT_PATHS) {
    const content = await readOptionalFile(workspace, path);
    if (content) {
      sections.push(`<project-context path="${path}">\n${truncateText(content, 8_000)}\n</project-context>`);
      break;
    }
  }

  return truncateText(sections.join("\n\n"), spec.maxContextChars);
}
