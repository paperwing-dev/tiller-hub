import { NavLink, useLocation } from "react-router";
import { Button } from "@cloudflare/kumo/components/button";
import { Select } from "@cloudflare/kumo/components/select";
import type { RepoMeta } from "../api/types";
import type { SetupStatus } from "./api";
import { projectGlobalSettingsPath, repoSettingsPath } from "./dashboard-paths";
import RepoSettingsPage from "./RepoSettingsPage";
import SettingsPage from "./SettingsPage";

export type WorkspaceSettingsSection = "global" | "project";

interface WorkspaceSettingsViewProps {
  repo: RepoMeta;
  repos: RepoMeta[];
  status: SetupStatus;
  activeSection: WorkspaceSettingsSection;
  onDone: () => void;
  onProjectChange: (repoId: string) => void;
  onRefresh: () => Promise<void>;
  implementationCount?: number;
  onRemoveProject?: () => Promise<void>;
}

function repoLabel(repo: RepoMeta): string {
  return repo.githubFullName || repo.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

function settingsLinkClass(active: boolean): string {
  return [
    "tiller-settings-nav-link block border-b border-kumo-line px-4 py-3 text-left",
    active
      ? "tiller-settings-scope-active bg-[var(--tiller-theme-action)]"
      : "text-kumo-default hover:bg-kumo-tint",
  ].join(" ");
}

export default function WorkspaceSettingsView({
  repo,
  repos,
  status,
  activeSection,
  onDone,
  onProjectChange,
  onRefresh,
  implementationCount = 0,
  onRemoveProject,
}: WorkspaceSettingsViewProps) {
  const location = useLocation();
  return (
    <section
      data-testid="workspace-settings-view"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-kumo-recessed"
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-kumo-line bg-kumo-base px-6 py-5">
        <h1 className="text-xl font-semibold text-kumo-strong text-balance">Settings</h1>
        <Button variant="secondary" size="sm" onClick={onDone}>Done</Button>
      </header>

      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <nav
          aria-label="Settings sections"
          className="w-56 shrink-0 border-r border-kumo-line bg-kumo-base max-md:flex max-md:w-full max-md:border-b max-md:border-r-0"
        >
          <NavLink
            to={projectGlobalSettingsPath(repo.repoId)}
            state={location.state}
            end
            className={({ isActive }) => `${settingsLinkClass(isActive)} max-md:w-1/2 max-md:border-b-0 max-md:border-r`}
            aria-current={activeSection === "global" ? "page" : undefined}
          >
            <span className="block text-[13px] font-semibold">Global settings</span>
            <span className={`mt-0.5 block text-[11px] ${activeSection === "global" ? "opacity-75" : "text-kumo-subtle"}`}>
              Models, hosting, and access
            </span>
          </NavLink>
          <NavLink
            to={repoSettingsPath(repo.repoId)}
            state={location.state}
            end
            className={({ isActive }) => `${settingsLinkClass(isActive)} max-md:w-1/2 max-md:border-b-0`}
            aria-current={activeSection === "project" ? "page" : undefined}
          >
            <span className="block text-[13px] font-semibold">Project settings</span>
            <span className={`mt-0.5 block text-[11px] ${activeSection === "project" ? "opacity-75" : "text-kumo-subtle"}`}>
              Variables and MCP access
            </span>
          </NavLink>
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activeSection === "global" ? (
            <div className="flex min-h-0 min-w-0 flex-1">
              <SettingsPage status={status} onRefresh={onRefresh} onDone={onDone} embedded />
            </div>
          ) : (
            <>
              <div className="shrink-0 border-b border-kumo-line bg-kumo-base">
                <div className="mx-auto flex w-full max-w-5xl items-end justify-between gap-6 px-6 py-5 max-sm:flex-col max-sm:items-stretch">
                  <div className="min-w-0 pb-1">
                    <h2 className="text-base font-semibold text-kumo-strong text-balance">Project settings</h2>
                    <p className="mt-1 max-w-xl text-sm text-kumo-subtle text-pretty">
                      Variables and MCP connections for this project.
                    </p>
                  </div>
                  <Select
                    label="Project"
                    className="w-full shrink-0 sm:w-80"
                    value={repo.repoId}
                    onValueChange={(value) => {
                      if (value && value !== repo.repoId) onProjectChange(value);
                    }}
                    items={repos.map((candidate) => ({ label: repoLabel(candidate), value: candidate.repoId }))}
                  />
                </div>
              </div>
              <div className="flex min-h-0 min-w-0 flex-1">
                <RepoSettingsPage
                  repo={repo}
                  onDone={onDone}
                  embedded
                  implementationCount={implementationCount}
                  onRemoveProject={onRemoveProject}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
