import { useMemo } from "react";
import { diffLines } from "diff";

interface DiffViewProps {
  oldString: string;
  newString: string;
  filePath?: string;
}

export default function DiffView({ oldString, newString, filePath }: DiffViewProps) {
  const diff = useMemo(
    () => diffLines(oldString || "", newString || ""),
    [oldString, newString],
  );

  const stats = useMemo(() => {
    const oldChars = (oldString || "").length;
    const newChars = (newString || "").length;
    return `${oldChars.toLocaleString()} → ${newChars.toLocaleString()} chars`;
  }, [oldString, newString]);

  return (
    <div className="overflow-hidden rounded-md border border-[#d0d7de] bg-white">
      {filePath && (
        <div className="border-b border-[#d0d7de] bg-[#f6f8fa] px-2 py-1 text-xs text-[#57606a] font-mono truncate">
          {filePath}
        </div>
      )}
      <div className="px-2 py-1 text-xs text-[#57606a] border-b border-[#d0d7de] bg-[#f6f8fa]">
        {stats}
      </div>
      <div className="font-mono text-xs max-h-64 overflow-auto">
        {diff.map((part, i) => {
          const lines = part.value.split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
          }

          const prefix = part.added ? "+" : part.removed ? "-" : " ";
          let className = "";
          if (part.added) className = "bg-[#dafbe1] text-[#1a7f37]";
          else if (part.removed) className = "bg-[#ffebe9] text-[#cf222e]";

          return (
            <div key={i} className={className}>
              {lines.map((line, j) => (
                <div key={j} className="whitespace-pre-wrap px-2">
                  {prefix} {line}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
