import type { Env } from "../../types";
import type { AvailableCodexModelRoute } from "../../model-route";
import {
  buildCodexRequestBody,
  buildCodexRequestConfig,
  extractOutputText,
  extractSseOutputIndex,
  extractSseOutputItem,
  isFunctionCallItem,
  parseCompletedOutput,
  parseErrorMessage,
  parseToolInput,
  readSseEvents,
  summarizeOutputTypes,
  type ResponseFunctionCallItem,
  type ResponseFunctionCallOutputItem,
  type ResponseInputItem,
  type ResponseOutputItem,
  type ResponseToolDefinition,
} from "../codex";
import {
  executeHostedTool,
  formatHostedToolError,
  normalizeHostedToolError,
} from "../tools";
import type { AgentSpec, HostedTool, HostedToolError, HostedToolName } from "../types";

const MAX_TOOL_OUTPUT_CHARS = 50_000;

type DirectToolsEnv = Env;

export interface DirectToolRuntimeHooks {
  onTextStart?(): void | Promise<void>;
  onTextDelta?(delta: string): void | Promise<void>;
  onToolStart?(call: ResponseFunctionCallItem): void | Promise<void>;
  onToolExecuting?(call: ResponseFunctionCallItem, input: Record<string, unknown>): void | Promise<void>;
  onToolResult?(
    call: ResponseFunctionCallItem,
    input: Record<string, unknown>,
    result: unknown,
  ): void | Promise<void>;
  onToolError?(
    call: ResponseFunctionCallItem,
    input: Record<string, unknown>,
    errorText: string,
    error: HostedToolError,
  ): void | Promise<void>;
  onAssistantTurn?(output: ResponseOutputItem[]): void | Promise<void>;
  onToolTurn?(toolOutputs: ResponseFunctionCallOutputItem[]): void | Promise<void>;
  onDone?(): void | Promise<void>;
}

export interface RunDirectToolsRuntimeParams {
  env: DirectToolsEnv;
  spec: AgentSpec;
  accessToken: string;
  accountId: string | null;
  model: string;
  systemPrompt: string;
  codexRoute?: AvailableCodexModelRoute | null;
  responseTools: ResponseToolDefinition[];
  toolRegistry: Map<HostedToolName, HostedTool>;
  initialInput: ResponseInputItem[];
  requestId?: string;
  hooks?: DirectToolRuntimeHooks;
}

function truncateToolResult(result: string): string {
  return result.length > MAX_TOOL_OUTPUT_CHARS
    ? `${result.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...(truncated)`
    : result;
}

function serializeToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export async function runDirectToolsRuntime({
  env,
  spec,
  accessToken,
  accountId,
  model,
  systemPrompt,
  codexRoute,
  responseTools,
  toolRegistry,
  initialInput,
  requestId = crypto.randomUUID(),
  hooks,
}: RunDirectToolsRuntimeParams): Promise<ResponseInputItem[]> {
  if (spec.modelTarget.provider !== "external-codex") {
    throw new Error(
      `runDirectToolsRuntime only supports external-codex models. ${spec.name} is configured for ${spec.modelTarget.provider}.`,
    );
  }

  const input = [...initialInput];
  const maxSteps = spec.maxSteps ?? 25;

  for (let step = 0; step < maxSteps; step += 1) {
    const body = buildCodexRequestBody(model, input, systemPrompt, responseTools);
    const request = await buildCodexRequestConfig(env, accessToken, accountId, requestId, body, codexRoute);
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    if (response.status === 401) {
      throw new Error("OpenAI auth expired — re-seed tokens");
    }

    if (!response.ok) {
      const text = (await response.text()).trim();
      const detail = text ? ` — ${text.slice(0, 500)}` : "";
      throw new Error(`Codex request failed: ${response.status}${detail}`);
    }

    if (!response.body) {
      throw new Error("Codex request failed: empty response body");
    }

    let completedOutput: ResponseOutputItem[] | null = null;
    const completedEventOutput: ResponseOutputItem[] = [];
    let textStarted = false;
    let streamedText = "";
    const announcedToolIds = new Set<string>();

    for await (const event of readSseEvents(response.body)) {
      if (event.data === "[DONE]") continue;

      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        throw new Error("Codex stream returned invalid JSON");
      }

      switch (event.event) {
        case "response.output_item.added":
        case "response.output_item.done": {
          const item = extractSseOutputItem(payload);
          if (!item) break;

          if (event.event === "response.output_item.done") {
            const outputIndex = extractSseOutputIndex(payload);
            if (outputIndex === null) {
              completedEventOutput.push(item);
            } else {
              completedEventOutput[outputIndex] = item;
            }
          }

          if (isFunctionCallItem(item) && !announcedToolIds.has(item.call_id)) {
            announcedToolIds.add(item.call_id);
            await hooks?.onToolStart?.(item);
          }
          break;
        }
        case "response.output_text.delta":
          if (payload && typeof payload === "object" && "delta" in payload && typeof payload.delta === "string") {
            if (!textStarted) {
              textStarted = true;
              await hooks?.onTextStart?.();
            }

            streamedText += payload.delta;
            await hooks?.onTextDelta?.(payload.delta);
          }
          break;
        case "response.completed":
          completedOutput = parseCompletedOutput(payload);
          break;
        case "response.failed":
        case "error":
          throw new Error(parseErrorMessage(payload, "Codex request failed"));
      }
    }

    if (!completedOutput) {
      throw new Error("Codex stream ended without response.completed");
    }

    const completedEventItems = completedEventOutput.filter((item): item is ResponseOutputItem => !!item);
    let output = completedOutput;
    let completedText = extractOutputText(output);
    let functionCalls = output.filter(isFunctionCallItem);
    if (completedText.length === 0 && functionCalls.length === 0 && completedEventItems.length > 0) {
      output = completedEventItems;
      completedText = extractOutputText(output);
      functionCalls = output.filter(isFunctionCallItem);
    }
    if (completedText) {
      if (!textStarted) {
        textStarted = true;
        await hooks?.onTextStart?.();
      }

      if (streamedText.length === 0) {
        streamedText = completedText;
        await hooks?.onTextDelta?.(completedText);
      } else if (completedText.startsWith(streamedText) && completedText.length > streamedText.length) {
        const remainder = completedText.slice(streamedText.length);
        streamedText = completedText;
        await hooks?.onTextDelta?.(remainder);
      }
    }

    if (!completedText && streamedText.length === 0 && functionCalls.length === 0) {
      throw new Error(
        `Codex completed without renderable text or tool calls. Output items: ${summarizeOutputTypes(output)}.`,
      );
    }

    input.push(...output);
    await hooks?.onAssistantTurn?.(output);

    if (functionCalls.length === 0) {
      await hooks?.onDone?.();
      return input;
    }

    const toolOutputs: ResponseFunctionCallOutputItem[] = [];
    for (const call of functionCalls) {
      const parsedInput = parseToolInput(call.arguments);
      await hooks?.onToolExecuting?.(call, parsedInput);

      let toolOutput: string;
      try {
        const result = await executeHostedTool(toolRegistry, call.name, parsedInput);
        if (result.ok) {
          toolOutput = truncateToolResult(serializeToolResult(result.output));
          await hooks?.onToolResult?.(call, parsedInput, result.output);
        } else {
          toolOutput = formatHostedToolError(result.error);
          await hooks?.onToolError?.(call, parsedInput, toolOutput, result.error);
        }
      } catch (error) {
        const toolError = normalizeHostedToolError(error);
        toolOutput = formatHostedToolError(toolError);
        await hooks?.onToolError?.(call, parsedInput, toolOutput, toolError);
      }

      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: toolOutput,
      });
    }

    input.push(...toolOutputs);
    await hooks?.onToolTurn?.(toolOutputs);
  }

  throw new Error(`Agent ${spec.name} exceeded maxSteps (${spec.maxSteps ?? 25})`);
}
