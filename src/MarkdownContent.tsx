import React from "react";
import ReactMarkdown from "react-markdown";

interface MarkdownContentProps {
  children: string;
  className?: string;
}

function MarkdownContent({ children, className = "" }: MarkdownContentProps) {
  return (
    <div className={`space-y-3 text-sm leading-6 text-kumo-default ${className}`}>
      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1 className="mt-6 border-b border-kumo-line pb-2 text-2xl font-semibold leading-tight text-kumo-strong first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-5 border-b border-kumo-line/70 pb-1.5 text-lg font-semibold leading-snug text-kumo-strong first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 text-base font-semibold leading-snug text-kumo-strong first:mt-0">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-3 text-sm font-semibold uppercase tracking-normal text-kumo-strong first:mt-0">
              {children}
            </h4>
          ),
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-4 border-kumo-line bg-kumo-recessed px-3 py-2 text-kumo-subtle">
              {children}
            </blockquote>
          ),
          a: ({ children, ...props }) => (
            <a {...props} className="text-kumo-link underline underline-offset-2" target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ children, className }) => (
            <code className={`${className ?? ""} tiller-markdown-code rounded border border-kumo-line bg-kumo-recessed px-1 py-0.5 font-mono text-[0.85em] text-kumo-strong`}>
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="tiller-markdown-pre my-3 overflow-x-auto rounded border border-kumo-line bg-kumo-recessed p-3 text-xs leading-5">
              {children}
            </pre>
          ),
          hr: () => <hr className="my-5 border-kumo-line" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// ReactMarkdown recreates its component tree when this component renders. Live
// plan metadata refreshes should not replace unchanged document text because
// doing so clears the user's browser selection.
export default React.memo(MarkdownContent);
