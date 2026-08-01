import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { useState } from "react";
import type { ReactNode } from "react";
import type { EnvMeta, RepoMeta } from "../api/types";
import { deleteRepo } from "./api";
import { getRepoMainStatusLabel, isRepoMainReady } from "./repo-status";

interface ProjectsHomeProps {
  repos: RepoMeta[];
  envs: EnvMeta[];
  hubUrl: string;
  toolbar?: ReactNode;
  onboarding: {
    dismissed: boolean;
    modelReady: boolean;
    executionReady: boolean;
    machineReady: boolean;
  } | null;
  onDismissOnboarding: () => Promise<void>;
  onOpenSettings: () => void;
  onAddProject: () => void;
  onOpenProject: (repoId: string) => void;
  onProjectDeleted: (repoId: string, deletedEnvSlugs: string[]) => void;
}

export default function ProjectsHome({
  repos,
  envs,
  hubUrl,
  toolbar,
  onboarding,
  onDismissOnboarding,
  onOpenSettings,
  onAddProject,
  onOpenProject,
  onProjectDeleted,
}: ProjectsHomeProps) {
  return (
    <main className="flex min-h-screen flex-col bg-kumo-base">
      <div className="border-b border-kumo-line bg-kumo-recessed px-5 py-3">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-kumo-strong">Tiller</h1>
          </div>
          {toolbar}
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-3 px-5 py-5">
        {onboarding && !onboarding.dismissed && (
          !onboarding.modelReady || !onboarding.executionReady || !onboarding.machineReady
        ) && (
          <OptionalOnboarding
            onboarding={onboarding}
            onDismiss={onDismissOnboarding}
            onOpenSettings={onOpenSettings}
          />
        )}
        <div className="flex justify-end">
          <Button type="button" variant="primary" size="sm" onClick={onAddProject}>
            Add Repo
          </Button>
        </div>

        {repos.length === 0 ? (
          <div className="flex flex-1 items-center justify-center border border-kumo-line bg-kumo-elevated">
            <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
              <p className="text-sm font-medium text-kumo-default">No repos yet</p>
              <Button type="button" variant="primary" size="sm" onClick={onAddProject}>
                Add Repo
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {repos.map((repo) => (
              <ProjectTile
                key={repo.repoId}
                repo={repo}
                envs={envs.filter((env) => env.repoId === repo.repoId)}
                hubUrl={hubUrl}
                onOpenProject={onOpenProject}
                onProjectDeleted={onProjectDeleted}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function OptionalOnboarding({
  onboarding,
  onDismiss,
  onOpenSettings,
}: {
  onboarding: NonNullable<ProjectsHomeProps["onboarding"]>;
  onDismiss: () => Promise<void>;
  onOpenSettings: () => void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const dismiss = async () => {
    setDismissing(true);
    try {
      await onDismiss();
    } finally {
      setDismissing(false);
    }
  };
  return (
    <section className="border border-kumo-line bg-kumo-elevated p-4" aria-label="Optional onboarding">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-kumo-strong">Finish setting up Tiller</h2>
          <p className="mt-1 text-xs text-kumo-subtle">
            These choices are optional. Tiller will prompt again when a feature needs one.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void dismiss()} disabled={dismissing}>
            {dismissing ? "Dismissing…" : "Dismiss"}
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={onOpenSettings}>
            Open settings
          </Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-kumo-subtle">
        <span>Model access: {onboarding.modelReady ? "ready" : "optional"}</span>
        <span>Execution: {onboarding.executionReady ? "ready" : "optional"}</span>
        <span>Machine: {onboarding.machineReady ? "connected" : "optional"}</span>
      </div>
    </section>
  );
}

function ProjectTile(props: ProjectItemProps) {
  const { repo, envs, hubUrl, onOpenProject, onProjectDeleted } = props;
  const [busy, setBusy] = useState(false);
  const stats = getProjectStats(envs);

  const handleDelete = async () => {
    const envWarning = envs.length > 0
      ? `\n\nThis will also destroy ${envs.length} environment(s) and their containers.`
      : "";
    if (!confirm(`Delete repo "${repoLabel(repo)}"?${envWarning}`)) return;

    setBusy(true);
    try {
      const result = await deleteRepo(hubUrl, repo.repoId);
      onProjectDeleted(result.repoId, result.deletedEnvSlugs);
    } catch (err) {
      console.error("[tiller] repo delete failed:", err);
      alert(err instanceof Error ? err.message : "Failed to delete repo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-48 border border-kumo-line bg-kumo-elevated p-4">
      <div className="min-w-0">
        <ProjectTitle repo={repo} />
        <ProjectMeta repo={repo} envs={envs} stats={stats} />
      </div>
      <div className="mt-5 grid grid-cols-2 border border-kumo-line">
        <StatCell label="Running" value={stats.runningCount} />
        <StatCell label="Changed" value={stats.changedCount} />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-kumo-subtle">Updated {formatDate(repo.updatedAt)}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="secondary-destructive"
            size="sm"
            onClick={handleDelete}
            disabled={busy}
          >
            {busy ? "..." : "Delete"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenProject(repo.repoId)}
            disabled={busy}
          >
            Open
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ProjectItemProps {
  repo: RepoMeta;
  envs: EnvMeta[];
  hubUrl: string;
  onOpenProject: (repoId: string) => void;
  onProjectDeleted: (repoId: string, deletedEnvSlugs: string[]) => void;
}

function ProjectTitle({ repo }: { repo: RepoMeta }) {
  const repoReady = isRepoMainReady(repo);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <h2 className="truncate text-base font-semibold text-kumo-strong">{repoLabel(repo)}</h2>
      {!repoReady && (
        <Badge variant={repo.gitStatus === "repair-required" ? "error" : "warning"}>
          {getRepoMainStatusLabel(repo)}
        </Badge>
      )}
    </div>
  );
}

function ProjectMeta({
  repo,
  envs,
  stats,
}: {
  repo: RepoMeta;
  envs: EnvMeta[];
  stats: ProjectStats;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-kumo-subtle">
      <a
        href={githubRepoHref(repo.repoUrl)}
        target="_blank"
        rel="noreferrer"
        className="text-kumo-link hover:underline"
      >
        {repo.githubFullName || repoLabel(repo)}
      </a>
      <span>{envs.length} envs</span>
      <span>{stats.runningCount} running</span>
      <span>{stats.changedCount} changed</span>
      <span>{stats.attentionCount} need attention</span>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-3 py-3">
      <p className="text-lg font-semibold text-kumo-strong">{value}</p>
      <p className="mt-0.5 text-[11px] text-kumo-subtle">{label}</p>
    </div>
  );
}

interface ProjectStats {
  runningCount: number;
  attentionCount: number;
  changedCount: number;
}

function getProjectStats(envs: EnvMeta[]): ProjectStats {
  const runningCount = envs.filter((env) => env.status === "running").length;
  const attentionCount = envs.filter((env) =>
    env.status === "failed" || env.branchStatus === "needs-attention" || env.workspaceNeedsAttention,
  ).length;
  const changedCount = envs.filter((env) =>
    env.workspaceDirty || env.branchStatus === "ready-to-merge",
  ).length;

  return { runningCount, attentionCount, changedCount };
}

function repoLabel(repo: Pick<RepoMeta, "repoUrl" | "githubFullName">): string {
  return repo.githubFullName || repo.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

function githubRepoHref(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
      return `https://github.com${parsed.pathname.replace(/\.git$/, "").replace(/\/+$/, "")}`;
    }
  } catch {
    // Fall through to the label-based URL below.
  }
  const label = repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return `https://github.com/${label}`;
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
