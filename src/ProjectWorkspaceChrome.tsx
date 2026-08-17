import { Select } from "@cloudflare/kumo/components/select";
import { useNavigate } from "react-router";
import { useDashboardData } from "./DashboardDataProvider";
import {
  planPath,
  projectImplementationsPath,
} from "./dashboard-paths";
import { getRepoLabel } from "./plan-repo";
import WorkspaceMetadata from "./WorkspaceMetadata";

interface ProjectWorkspaceChromeProps {
  repoId: string | null;
  activeView: "plans" | "implementations";
  planCount: number;
  planWarningCount?: number;
  planUpdateCount?: number;
  implementationCount: number;
  implementationAttentionCount?: number;
  implementationUpdateCount?: number;
}

const ADD_PROJECT_VALUE = "__tiller_add_project__";

export default function ProjectWorkspaceChrome({
  repoId,
  activeView,
  planCount,
  planWarningCount = 0,
  planUpdateCount = 0,
  implementationCount,
  implementationAttentionCount = 0,
  implementationUpdateCount = 0,
}: ProjectWorkspaceChromeProps) {
  const data = useDashboardData();
  const navigate = useNavigate();

  return (
    <div className="flex h-16 shrink-0 border-b border-kumo-line bg-kumo-recessed">
      <div className="tiller-workspace-sidebar-shell flex w-80 shrink-0 flex-col justify-center border-r border-kumo-line px-4">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="tiller-wordmark tiller-plan-brand-wordmark inline-flex h-8 w-fit items-center text-[15px] font-bold leading-none text-kumo-default"
          aria-label="Tiller"
        >
          tiller
        </button>
        <Select<string>
          aria-label="Switch project"
          className="tiller-project-switcher w-full"
          size="sm"
          placeholder="No project"
          value={repoId}
          onValueChange={(nextRepoId) => {
            if (nextRepoId === ADD_PROJECT_VALUE) {
              data.setShowNewRepo(true);
              return;
            }
            if (!nextRepoId || nextRepoId === repoId) return;
            navigate(activeView === "implementations"
              ? projectImplementationsPath(nextRepoId)
              : planPath(nextRepoId));
          }}
          items={[
            ...(data.repos ?? []).map((repo) => ({
              label: repo.githubFullName || getRepoLabel(repo.repoUrl),
              value: repo.repoId,
            })),
            { label: "Add project…", value: ADD_PROJECT_VALUE },
          ]}
        />
      </div>

      <div className="relative flex min-w-0 flex-1 items-stretch">
        <nav aria-label="Project views" className="flex min-w-0 shrink-0 items-end">
          <ProjectTab
            label="Plans"
            count={planCount}
            active={activeView === "plans"}
            warningCount={planWarningCount}
            warningLabel={`${planWarningCount} ${planWarningCount === 1 ? "plan needs" : "plans need"} attention`}
            updateCount={planUpdateCount}
            updateLabel={`${planUpdateCount} ${planUpdateCount === 1 ? "plan has" : "plans have"} new updates`}
            disabled={!repoId}
            onClick={() => {
              if (repoId) navigate(planPath(repoId));
            }}
          />
          <ProjectTab
            label="Implementations"
            count={implementationCount}
            active={activeView === "implementations"}
            warningCount={implementationAttentionCount}
            warningLabel={`${implementationAttentionCount} ${implementationAttentionCount === 1 ? "implementation needs" : "implementations need"} attention`}
            updateCount={implementationUpdateCount}
            updateLabel={`${implementationUpdateCount} ${implementationUpdateCount === 1 ? "implementation is" : "implementations are"} waiting for you`}
            disabled={!repoId}
            onClick={() => {
              if (repoId) navigate(projectImplementationsPath(repoId));
            }}
          />
        </nav>
      </div>
    </div>
  );
}

function ProjectTab({
  label,
  count,
  active,
  warningCount = 0,
  warningLabel = "",
  updateCount = 0,
  updateLabel = "",
  disabled = false,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  warningCount?: number;
  warningLabel?: string;
  updateCount?: number;
  updateLabel?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      className={`tiller-hover-count-metadata tiller-project-tab relative -mb-px flex h-8 items-center gap-2 border px-3 text-[12px] transition-colors disabled:cursor-default disabled:opacity-50 ${
        active
          ? "border-kumo-line border-b-kumo-base bg-kumo-base font-semibold text-kumo-default"
          : "border-transparent font-medium text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
      }`}
    >
      <span>{label}</span>
      <WorkspaceMetadata
        count={count}
        warning={{ count: warningCount, label: warningLabel }}
        update={{ count: updateCount, label: updateLabel }}
        className="text-kumo-default"
      />
    </button>
  );
}
