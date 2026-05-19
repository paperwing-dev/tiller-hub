import { useState } from "react";
import { useToast } from "./Toast";
import type { SetupStatus } from "./api";
import { submitSetup } from "./api";

const HUB_URL = window.location.origin;

type ModelAuthMode = "subscription" | "api" | "openai-api";

interface SetupWizardProps {
  status: SetupStatus;
  onRefresh: () => Promise<void>;
}

export default function SetupWizard({ status, onRefresh }: SetupWizardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialModelMode: ModelAuthMode =
    status.modelAuthMode === "subscription"
    || status.modelAuthMode === "api"
    || status.modelAuthMode === "openai-api"
      ? status.modelAuthMode
      : status.hasClaudeSubscription
        ? "subscription"
        : status.hasOpenAIKey
          ? "openai-api"
          : "api";
  const [modelMode, setModelMode] = useState<ModelAuthMode>(initialModelMode);
  const [modelCredential, setModelCredential] = useState("");
  const addToast = useToast();
  const codexVisible =
    status.enabledHarnesses.includes("codex") || status.hasOpenAIKey || status.hasChatGPTAuth;
  const opencodeVisible = status.enabledHarnesses.includes("opencode");

  async function advanceModelAccess() {
    if (!modelCredential.trim()) {
      setError("Enter a credential to continue.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await submitSetup(HUB_URL, {
        [modelMode === "subscription"
          ? "CLAUDE_CODE_OAUTH_TOKEN"
          : modelMode === "api"
            ? "ANTHROPIC_API_KEY"
            : "OPENAI_API_KEY"]: modelCredential.trim(),
      });
      await onRefresh();
      addToast({
        title: "Setup complete",
        body: "Model access is saved. Open Settings when you want to publish, protect, or prepare CLI access.",
        variant: "success",
      });
      setModelCredential("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <div className="mx-auto flex w-full max-w-5xl gap-10 px-6 py-8">
        <aside className="hidden w-64 shrink-0 lg:block">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#57606a]">Required setup</p>
          <h1 className="mt-2 text-2xl font-semibold text-[#24292f]">Connect model access</h1>
          <p className="mt-2 text-sm text-[#57606a]">
            First-run only requires one working auth path for an enabled harness. Saving it opens the app immediately.
          </p>
          <div className="mt-8 space-y-3">
            <div className="rounded-xl border border-[#d0d7de] bg-[#f6f8fa] px-4 py-4">
              <p className="text-sm font-semibold text-[#24292f]">What happens after save</p>
              <p className="mt-2 text-xs text-[#57606a]">
                Tiller enters the main app as soon as model access is configured.
              </p>
            </div>
            <div className="rounded-xl border border-[#d0d7de] bg-white px-4 py-4">
              <p className="text-sm font-semibold text-[#24292f]">
                {status.isLocalDev ? "After save on localhost" : "Optional later in Settings"}
              </p>
              <p className="mt-2 text-xs text-[#57606a]">
                {status.isLocalDev
                  ? "Run `tiller host` in another terminal when you want host environments to start. Hosted ChatGPT planning and research stay unavailable on a localhost hub."
                  : "Publish to your own domain and enable Cloudflare Access when you need them."}
              </p>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <div className="rounded-2xl border border-[#d0d7de] bg-[#f6f8fa] p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#57606a]">Model access</p>

            <div className="mt-3">
              <h2 className="text-xl font-semibold text-[#24292f]">Choose how Tiller should authenticate models</h2>
              <p className="mt-2 text-sm text-[#57606a]">
                {status.isLocalDev
                  ? "This is the only required setup step. Add Claude or Codex access, then run `tiller host` when you want host environments. OpenCode uses the built-in Workers AI proxy."
                  : "This is the only required setup step. After save, you can manage publish, protection, and Claude/Codex credentials from Settings. OpenCode uses the built-in Workers AI proxy."}
              </p>

              <div className={`mt-6 grid gap-3 ${codexVisible ? "md:grid-cols-2 xl:grid-cols-3" : "md:grid-cols-2"}`}>
                <button
                  type="button"
                  onClick={() => setModelMode("subscription")}
                  className={`rounded-xl border px-4 py-4 text-left transition-colors ${
                    modelMode === "subscription"
                      ? "border-[#0969da] bg-[#ddf4ff]"
                      : "border-[#d0d7de] bg-white hover:border-[#0969da]/40"
                  }`}
                >
                  <p className="text-sm font-semibold text-[#24292f]">Claude subscription</p>
                  <p className="mt-1 text-xs text-[#57606a]">
                    Preferred when you want Tiller to use your Claude subscription token.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setModelMode("api")}
                  className={`rounded-xl border px-4 py-4 text-left transition-colors ${
                    modelMode === "api"
                      ? "border-[#0969da] bg-[#ddf4ff]"
                      : "border-[#d0d7de] bg-white hover:border-[#0969da]/40"
                  }`}
                >
                  <p className="text-sm font-semibold text-[#24292f]">Anthropic API key</p>
                  <p className="mt-1 text-xs text-[#57606a]">
                    Use this when you want API-billed Claude access from the start.
                  </p>
                </button>
                {codexVisible && (
                  <button
                    type="button"
                    onClick={() => setModelMode("openai-api")}
                    className={`rounded-xl border px-4 py-4 text-left transition-colors ${
                      modelMode === "openai-api"
                        ? "border-[#0969da] bg-[#ddf4ff]"
                        : "border-[#d0d7de] bg-white hover:border-[#0969da]/40"
                    }`}
                  >
                    <p className="text-sm font-semibold text-[#24292f]">OpenAI API key</p>
                    <p className="mt-1 text-xs text-[#57606a]">
                      Use this for API-billed Codex access in Cloudflare Containers.
                    </p>
                  </button>
                )}
              </div>

              <div className="mt-6">
                <label className="text-xs font-medium text-[#24292f]">
                  {modelMode === "subscription"
                    ? "Claude Code OAuth token"
                    : modelMode === "api"
                      ? "Anthropic API key"
                      : "OpenAI API key"}
                </label>
                <input
                  type="password"
                  value={modelCredential}
                  onChange={(e) => setModelCredential(e.target.value)}
                  placeholder={
                    modelMode === "subscription"
                      ? "Paste your Claude subscription token"
                      : modelMode === "api"
                        ? "Paste your Anthropic API key"
                        : "Paste your OpenAI API key"
                  }
                  disabled={busy}
                  className="mt-2 w-full rounded-lg border border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] focus:border-[#0969da] focus:outline-none focus:ring-1 focus:ring-[#0969da]/30"
                />
              </div>

              <div className="mt-6 rounded-xl border border-[#d0d7de] bg-white px-4 py-4">
                <p className="text-sm font-semibold text-[#24292f]">After setup</p>
                <p className="mt-2 text-xs text-[#57606a]">
                {status.isLocalDev
                    ? "Keep `npm run dev` open here, then run `tiller host` before you start an environment. A localhost hub does not expose the Cloudflare Containers backend, and hosted ChatGPT planning still needs a published host gateway."
                    : "Open Settings anytime to publish to a custom domain and add Cloudflare Access. For Tiller CLI access, install <code>tiller</code> and run <code>tiller</code>. Run <code>tiller host</code> on your always-on machine when you want host environments. Protected hubs prompt through the browser on first run."}
                </p>
                {codexVisible && (
                  <p className="mt-2 text-xs text-[#57606a]">
                    If you want subscription-backed Codex, connect ChatGPT in Tiller and keep a published Tiller Host
                    gateway online. Tiller Host environments use that gateway locally, and Cloudflare Containers use the
                    OpenAI API key.
                  </p>
                )}
                {opencodeVisible && (
                  <p className="mt-2 text-xs text-[#57606a]">
                    OpenCode uses Tiller&apos;s built-in Workers AI binding through the hub proxy. No extra Cloudflare
                    credentials are needed, and OpenCode stays pinned to Kimi K2.5.
                  </p>
                )}
              </div>

              <div className="mt-6 flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => void advanceModelAccess()}
                  disabled={busy || !modelCredential.trim()}
                  className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0a5bc4] disabled:opacity-40"
                >
                  {busy ? "Saving..." : "Save and open Tiller"}
                </button>
              </div>
            </div>

            {error && <p className="mt-6 text-sm text-red-600">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
