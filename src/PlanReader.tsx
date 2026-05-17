import ReactMarkdown from "react-markdown";
import type { PlanArtifact } from "../api/coordination/types";
import { renderArtifactBodyMarkdown } from "./plan-artifacts";

interface PlanReaderProps {
  plan: PlanArtifact | null;
  streaming?: boolean;
}

export default function PlanReader({ plan, streaming = false }: PlanReaderProps) {
  if (!plan) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[#57606a]">
        Select or create a plan.
      </div>
    );
  }

  const markdown = renderArtifactBodyMarkdown(plan.body);
  const displayVersion = getDisplayVersion(plan, markdown);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-[#24292f]">
            {plan.title || "Untitled plan"}
          </h1>
          <div className="mt-1 text-xs text-[#57606a]">
            v{displayVersion} · {formatTimestamp(plan.updatedAt)}
          </div>
        </div>
        {streaming && (
          <span className="shrink-0 rounded border border-[#bfdbfe] bg-[#eff6ff] px-2 py-1 text-xs text-[#1d4ed8]">
            Writer is updating...
          </span>
        )}
      </div>

      {markdown.trim() ? (
        <article className="prose prose-sm max-w-none text-[#24292f] prose-headings:text-[#24292f] prose-a:text-[#0969da] prose-pre:border prose-pre:border-[#d0d7de] prose-pre:bg-[#f6f8fa]">
          <ReactMarkdown
            components={{
              a: ({ node: _node, ...props }) => (
                <a {...props} target="_blank" rel="noreferrer" />
              ),
            }}
          >
            {markdown}
          </ReactMarkdown>
        </article>
      ) : (
        <div className="rounded border border-dashed border-[#d0d7de] bg-[#f6f8fa] px-4 py-6 text-sm text-[#57606a]">
          This plan is empty.
        </div>
      )}
    </div>
  );
}

function getDisplayVersion(plan: PlanArtifact, markdown: string): number {
  if (!markdown.trim()) return 0;
  return Math.max(1, (plan.version ?? 1) - 1);
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
