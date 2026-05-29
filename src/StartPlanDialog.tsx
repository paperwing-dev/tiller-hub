import { useEffect, useMemo, useState } from "react";
import type { EnvMeta } from "../api/types";
import type { Artifact } from "../api/coordination/types";
import { fetchRepoArtifacts, startEnv, type StartupPlanSelection } from "./api";
import { isPlanOutdatedForMain, listPlanArtifacts, renderArtifactBodyMarkdown } from "./plan-artifacts";

interface StartPlanDialogProps {
  env: EnvMeta;
  repoMainCommit: string | null;
  hubUrl: string;
  onClose: () => void;
  onStarted: () => void;
}

type PlanChoice = "specific" | "none";

export default function StartPlanDialog({
  env,
  repoMainCommit,
  hubUrl,
  onClose,
  onStarted,
}: StartPlanDialogProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<PlanChoice>("none");
  const [selectedPlanId, setSelectedPlanId] = useState("");

  const planArtifacts = useMemo(() => listPlanArtifacts(artifacts), [artifacts]);
  const selectedPlan = useMemo(
    () => planArtifacts.find((plan) => plan.id === selectedPlanId) ?? planArtifacts[0] ?? null,
    [planArtifacts, selectedPlanId],
  );

  useEffect(() => {
    let cancelled = false;
    const loadPlans = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!env.repoId) {
          setArtifacts([]);
          setError("This environment does not have a repo identity yet.");
          return;
        }
        const nextState = await fetchRepoArtifacts(hubUrl, env.repoId);
        if (cancelled) return;
        setArtifacts(nextState.artifacts);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load plans");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadPlans();
    return () => {
      cancelled = true;
    };
  }, [env.repoId, hubUrl]);

  useEffect(() => {
    setSelectedPlanId((current) => {
      if (current && planArtifacts.some((plan) => plan.id === current)) return current;
      return env.startupPlanId && planArtifacts.some((plan) => plan.id === env.startupPlanId)
        ? env.startupPlanId
        : planArtifacts[0]?.id ?? "";
    });
  }, [env.startupPlanId, planArtifacts]);

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      let planSelection: StartupPlanSelection = { mode: "none" };
      if (choice === "specific") {
        if (!selectedPlan) {
          throw new Error("Choose a plan before starting the container.");
        }
        planSelection = { mode: "specific", artifactId: selectedPlan.id };
      }
      await startEnv(hubUrl, env.slug, { planSelection });
      onStarted();
      onClose();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Failed to start container");
    } finally {
      setStarting(false);
    }
  };

  const selectedSpecificOutdated = choice === "specific" && selectedPlan && isPlanOutdatedForMain(selectedPlan, repoMainCommit);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="mx-4 w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="border-b border-[#d0d7de] px-5 py-4">
          <h3 className="text-sm font-semibold text-[#24292f]">Start Container</h3>
          <p className="mt-1 text-xs text-[#57606a]">
            Start without a plan, or pick a specific saved plan.
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <div className="text-xs font-medium text-[#57606a]">Repository</div>
            <div className="mt-1 text-sm text-[#24292f]">
              {env.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-[#57606a]">Plan</div>
            {loading ? (
              <div className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-sm text-[#57606a]">
                Loading plans...
              </div>
            ) : (
              <div className="space-y-2">
                <label className="flex cursor-pointer items-start gap-3 rounded border border-[#d0d7de] px-3 py-2">
                  <input
                    type="radio"
                    name={`plan-choice-${env.slug}`}
                    checked={choice === "none"}
                    onChange={() => setChoice("none")}
                    disabled={starting}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#24292f]">No plan</div>
                    <div className="text-xs text-[#57606a]">
                      Start the container without writing /.tiller/plan.md.
                    </div>
                  </div>
                </label>

                <label className="flex cursor-pointer items-start gap-3 rounded border border-[#d0d7de] px-3 py-2">
                  <input
                    type="radio"
                    name={`plan-choice-${env.slug}`}
                    checked={choice === "specific"}
                    onChange={() => setChoice("specific")}
                    disabled={planArtifacts.length === 0 || starting}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[#24292f]">Choose specific plan</div>
                    <select
                      value={selectedPlanId}
                      onChange={(event) => setSelectedPlanId(event.target.value)}
                      disabled={choice !== "specific" || planArtifacts.length === 0 || starting}
                      className="mt-2 w-full rounded border border-[#d0d7de] bg-white px-2 py-1.5 text-sm text-[#24292f] disabled:opacity-50"
                    >
                      {planArtifacts.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.title || "Untitled plan"}
                          {isPlanOutdatedForMain(plan, repoMainCommit) ? " (main mismatch)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>

              </div>
            )}
          </div>

          {selectedPlan && choice === "specific" && !loading && (
            <div className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-3">
              <div className="text-xs font-medium text-[#57606a]">Selected plan</div>
              <div className="mt-1 text-sm font-medium text-[#24292f]">{selectedPlan.title || "Untitled plan"}</div>
              <div className="mt-1 text-xs text-[#57606a]">
                Updated {formatTimestamp(selectedPlan.updatedAt)}
              </div>
              {selectedSpecificOutdated && (
                <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                  This plan was saved against a different main commit. You can still start with it because it was explicitly selected.
                </div>
              )}
              <div className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-[#24292f]">
                {renderArtifactBodyMarkdown(selectedPlan.body)}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-[#d0d7de] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={starting}
            className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs text-[#57606a] hover:bg-[#f6f8fa] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={loading || starting}
            className="rounded bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0a5bc4] disabled:opacity-40"
          >
            {starting ? "Starting..." : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
