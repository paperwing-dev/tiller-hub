import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { aiTools, createCodeTool } from "@cloudflare/codemode/ai";
import type { ToolSet } from "ai";

export interface CodemodeRuntimeOptions {
  loader: WorkerLoader;
  tools: ToolSet;
}

export function createCodemodeTool({ loader, tools }: CodemodeRuntimeOptions) {
  const executor = new DynamicWorkerExecutor({
    loader,
    globalOutbound: null,
  });

  return createCodeTool({
    tools: [aiTools(tools)],
    executor,
  });
}
