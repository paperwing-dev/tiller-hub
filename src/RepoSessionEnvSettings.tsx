import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import type { RepoMeta } from "../api/types";
import type { RepoSessionEnvVar } from "./api";
import { fetchRepoSessionEnv, patchRepoSessionEnv } from "./api";
import { useToast } from "./Toast";

const HUB_URL = window.location.origin;

function formatSessionEnvUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function RepoSessionEnvSettings({ repo }: { repo: RepoMeta }) {
  const [vars, setVars] = useState<RepoSessionEnvVar[]>([]);
  const [loadingVars, setLoadingVars] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const addToast = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoadingVars(true);
    setError(null);
    fetchRepoSessionEnv(HUB_URL, repo.repoId)
      .then((nextVars) => {
        if (!cancelled) setVars(nextVars);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingVars(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repo.repoId]);

  async function handleSaveVar() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (name !== trimmedName) {
      setError("Environment variable name cannot start or end with spaces.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const nextVars = await patchRepoSessionEnv(HUB_URL, repo.repoId, {
        set: { [trimmedName]: value },
      });
      setVars(nextVars);
      setName("");
      setValue("");
      addToast({ title: "Session env updated", variant: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteVar(varName: string) {
    setSaving(true);
    setError(null);
    try {
      const nextVars = await patchRepoSessionEnv(HUB_URL, repo.repoId, {
        delete: [varName],
      });
      setVars(nextVars);
      addToast({ title: "Session env removed", variant: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4">
      <p className="text-xs leading-5 text-kumo-subtle">
        These values are stored by Tiller and injected into newly started sessions for this repository. Commands running inside those sessions can read and print them. Existing running sessions are unchanged until restarted.
      </p>

      <div className="rounded-xl border border-kumo-line bg-kumo-recessed">
        <div className="grid grid-cols-[minmax(0,1fr)_120px_80px] gap-3 border-b border-kumo-line px-3 py-2 text-xs font-semibold text-kumo-subtle">
          <span>Name</span>
          <span>Updated</span>
          <span className="text-right">Action</span>
        </div>
        {loadingVars ? (
          <div className="px-3 py-4 text-sm text-kumo-subtle">Loading session env...</div>
        ) : vars.length === 0 ? (
          <div className="px-3 py-4 text-sm text-kumo-subtle">No session env values are stored for this repository.</div>
        ) : (
          vars.map((entry) => (
            <div key={entry.name} className="grid grid-cols-[minmax(0,1fr)_120px_80px] items-center gap-3 border-b border-kumo-line px-3 py-2 last:border-b-0">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-kumo-default">{entry.name}</p>
                <p className="mt-0.5 font-mono text-xs text-kumo-subtle">********</p>
              </div>
              <p className="text-xs text-kumo-subtle">{formatSessionEnvUpdatedAt(entry.updatedAt)}</p>
              <Button
                variant="secondary-destructive"
                size="sm"
                onClick={() => void handleDeleteVar(entry.name)}
                disabled={saving}
                className="justify-self-end"
              >
                Delete
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="grid gap-2 rounded-xl border border-kumo-line bg-kumo-base px-3 py-3 md:grid-cols-[minmax(160px,220px)_minmax(0,1fr)_auto] md:items-end">
        <Input
          label="Name"
          value={name}
          onValueChange={setName}
          placeholder="EXAMPLE_FLAG"
          disabled={saving}
          className="font-mono"
        />
        <Input
          label="Value"
          value={value}
          onValueChange={setValue}
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
        />
        <Button
          variant="primary"
          onClick={() => void handleSaveVar()}
          disabled={saving || !name.trim() || !value}
        >
          Add / Replace
        </Button>
      </div>

      {error && <p className="text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}
