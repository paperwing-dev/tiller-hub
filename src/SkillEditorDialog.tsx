import React, { useEffect, useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Field } from "@cloudflare/kumo/components/field";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { InputGroup } from "@cloudflare/kumo/components/input-group";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import {
  createAgentSkill,
  deleteAgentSkill,
  updateAgentSkill,
  type AgentRoute,
  type AgentSkillDefinition,
} from "./api";
import type { AgentDefinition, PlannerEffort } from "../api/coordination/types";
import SkillAutomationToggle from "./SkillAutomationToggle";

const HUB_URL = window.location.origin;
const EMPTY_ROUTES: AgentRoute[] = [];
const EMPTY_SKILLS: AgentSkillDefinition[] = [];
const EFFORT_LABELS: Record<PlannerEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultra: "Ultra",
  max: "Max",
};

interface SkillEditorDialogProps {
  repoId: string;
  surface: "plan" | "review";
  open: boolean;
  skills: AgentSkillDefinition[];
  routes: AgentRoute[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => void | Promise<void>;
}

type Draft = Omit<AgentSkillDefinition, "id" | "origin" | "customized" | "createdAt" | "updatedAt">;

function defaultRoute(routes: AgentRoute[]): AgentRoute | null {
  return routes.find((route) => route.key === "codex:gpt-5.5")
    ?? routes.find((route) => route.available)
    ?? routes[0]
    ?? null;
}

function newAgent(routes: AgentRoute[], index = 0): AgentDefinition {
  const route = defaultRoute(routes);
  return {
    id: crypto.randomUUID(),
    label: index === 0 ? "Reviewer" : `Reviewer ${index + 1}`,
    routeKey: route?.key ?? "",
    effort: route?.defaultEffort ?? "high",
    instructions: "Describe this reviewer's focused role.",
    reportMode: "auto",
  };
}

function emptyDraft(surface: "plan" | "review", routes: AgentRoute[]): Draft {
  return {
    surface,
    command: "",
    label: "",
    description: "",
    sharedInstructions: "Describe the shared goal and immutable basis every agent should use.",
    overviewInstructions: "Deduplicate findings and preserve attribution.",
    overviewMode: surface === "review" ? "auto" : "manual",
    agents: [newAgent(routes)],
  };
}

function cloneDraft(skill: AgentSkillDefinition): Draft {
  return {
    surface: skill.surface,
    command: skill.command,
    label: skill.label,
    description: skill.description,
    sharedInstructions: skill.sharedInstructions,
    overviewInstructions: skill.overviewInstructions,
    overviewMode: skill.overviewMode,
    agents: skill.agents.map((agent) => ({ ...agent })),
  };
}

export default function SkillEditorDialog({
  repoId,
  surface,
  open,
  skills,
  routes,
  onOpenChange,
  onChanged,
}: SkillEditorDialogProps) {
  // A few hosts load provider metadata and skill definitions independently.
  // Treat a temporarily absent projection as empty so the editor can render
  // while either request is still settling.
  routes = routes ?? EMPTY_ROUTES;
  skills = skills ?? EMPTY_SKILLS;
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(surface, routes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = selectedId && selectedId !== "new"
    ? skills.find((skill) => skill.id === selectedId) ?? null
    : null;
  const fanout = draft.agents.length > 1;
  const routesByKey = useMemo(() => new Map(routes.map((route) => [route.key, route])), [routes]);

  useEffect(() => {
    if (!open) return;
    const first = skills[0] ?? null;
    setSelectedId(first?.id ?? "new");
    setDraft(first ? cloneDraft(first) : emptyDraft(surface, routes));
    setError(null);
  }, [open, routes, skills, surface]);

  if (!open) return null;

  const choose = (skill: AgentSkillDefinition) => {
    setSelectedId(skill.id);
    setDraft(cloneDraft(skill));
    setError(null);
  };

  const add = () => {
    setSelectedId("new");
    setDraft(emptyDraft(surface, routes));
    setError(null);
  };

  const updateAgent = (id: string, update: Partial<AgentDefinition>) => {
    setDraft((current) => ({
      ...current,
      agents: current.agents.map((agent) => agent.id === id ? { ...agent, ...update } : agent),
    }));
  };

  const chooseRoute = (agent: AgentDefinition, routeKey: string) => {
    const route = routesByKey.get(routeKey);
    if (!route) return;
    const effort = route.supportedEfforts.includes(agent.effort) ? agent.effort : route.defaultEffort;
    updateAgent(agent.id, { routeKey, effort });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (selectedId === "new") {
        const created = await createAgentSkill(HUB_URL, repoId, draft);
        await onChanged();
        setSelectedId(created.id);
        setDraft(cloneDraft(created));
      } else if (selected) {
        const saved = await updateAgentSkill(HUB_URL, repoId, surface, selected.id, draft);
        await onChanged();
        setDraft(cloneDraft(saved));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save skill");
    } finally {
      setSaving(false);
    }
  };

  const removeOrReset = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await deleteAgentSkill(HUB_URL, repoId, surface, selected.id);
      await onChanged();
      setSelectedId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to delete skill");
    } finally {
      setSaving(false);
    }
  };

  const visibleSkills = selectedId === "new"
    ? [...skills, { id: "new", ...draft }]
    : skills;

  return (
    <Dialog.Root open onOpenChange={(nextOpen) => { if (!nextOpen) onOpenChange(false); }}>
      <Dialog size="xl" className="flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-[1200px] flex-col overflow-hidden p-0 sm:w-[calc(100vw-2rem)]">
        <div className="flex items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
          <div>
            <Dialog.Title className="text-sm font-semibold text-kumo-strong">
              {surface === "plan" ? "Plan Skills" : "Review Skills"}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-kumo-subtle">
              One slash command configures the agent experience used when invoked.
            </Dialog.Description>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-r border-kumo-line bg-kumo-recessed">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-kumo-line bg-kumo-recessed px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-kumo-subtle">Commands</span>
              <Button type="button" size="xs" variant="secondary" disabled={saving} onClick={add}>Add</Button>
            </div>
            {visibleSkills.map((skill) => (
              <Button
                key={skill.id}
                type="button"
                variant="ghost"
                onClick={() => { if (skill.id !== "new") choose(skill as AgentSkillDefinition); }}
                className={`block h-auto w-full rounded-none border-b border-kumo-line px-3 py-3 text-left ${selectedId === skill.id ? "bg-kumo-info/10" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-kumo-info">/{skill.command || "new-skill"}</span>
                  <Badge variant="outline" className="text-[9px] uppercase">
                    {skill.agents.length} agent{skill.agents.length === 1 ? "" : "s"}
                  </Badge>
                </div>
                <div className="mt-1 truncate text-xs font-medium text-kumo-default">{skill.label || "Untitled skill"}</div>
                <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-kumo-subtle">{skill.description}</div>
              </Button>
            ))}
          </aside>

          <div className="min-h-0 overflow-y-auto p-4">
            <div className="w-full space-y-5">
              <LayerCard className="bg-kumo-recessed p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Command">
                    <InputGroup size="sm" disabled={selected?.origin === "builtin" || saving} className="w-full">
                      <InputGroup.Addon>/</InputGroup.Addon>
                      <InputGroup.Input
                        aria-label="Command"
                        value={draft.command}
                        onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
                        className="font-mono"
                      />
                    </InputGroup>
                  </Field>
                  <Input
                    size="sm"
                    label="Skill name"
                    value={draft.label}
                    disabled={saving}
                    onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
                  />
                </div>
                <div className="mt-3">
                  <Input
                    size="sm"
                    label="Description"
                    value={draft.description}
                    disabled={saving}
                    onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                  />
                </div>
                {fanout && (
                  <>
                    <div className="mt-3">
                      <Textarea
                        size="sm"
                        label="Shared goal"
                        description="Sent to every child agent."
                        value={draft.sharedInstructions}
                        disabled={saving}
                        onChange={(event) => setDraft((current) => ({ ...current, sharedInstructions: event.target.value }))}
                        rows={3}
                        className="w-full resize-y text-xs leading-5"
                      />
                    </div>
                    {surface === "review" && (
                      <div className="mt-3">
                        <Textarea
                          size="sm"
                          label="Reviewer instructions"
                          description="Included when agent reports are sent together."
                          value={draft.overviewInstructions}
                          disabled={saving}
                          onChange={(event) => setDraft((current) => ({ ...current, overviewInstructions: event.target.value }))}
                          rows={3}
                          className="w-full resize-y text-xs leading-5"
                        />
                      </div>
                    )}
                  </>
                )}
              </LayerCard>

              <section>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-kumo-strong">{draft.agents.length === 1 ? "Agent" : "Agents"}</h3>
                    <p className="text-xs text-kumo-subtle">
                      {draft.agents.length === 1
                        ? "This agent runs directly in the current tab."
                        : "Each agent becomes a nested, fully interactive tab."}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={draft.agents.length >= 4 || saving}
                    onClick={() => setDraft((current) => ({ ...current, agents: [...current.agents, newAgent(routes, current.agents.length)] }))}
                  >
                    Add agent
                  </Button>
                </div>

                <div className="space-y-3">
                  {draft.agents.map((agent, index) => {
                    const route = routesByKey.get(agent.routeKey) ?? null;
                    return (
                      <LayerCard key={agent.id} className="bg-kumo-recessed p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-kumo-info/15 text-[10px] font-bold text-kumo-info">{index + 1}</span>
                            <span className="truncate text-xs font-semibold text-kumo-strong">{agent.label || "Untitled agent"}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            {surface === "review" && fanout && (
                              <SkillAutomationToggle
                                value={agent.reportMode}
                                onChange={(reportMode) => updateAgent(agent.id, { reportMode })}
                                ariaLabel={`${agent.label || `Agent ${index + 1}`} default report mode`}
                                manualTooltip="Keep responses in this agent tab until you choose one to send."
                                autoTooltip="Send each completed response to Overview automatically."
                                disabled={saving}
                              />
                            )}
                            <Button
                              type="button"
                              size="xs"
                              variant="secondary-destructive"
                              aria-label={`Remove agent ${index + 1}`}
                              title="Remove agent"
                              disabled={draft.agents.length === 1 || saving}
                              onClick={() => setDraft((current) => ({ ...current, agents: current.agents.filter((entry) => entry.id !== agent.id) }))}
                              className="ml-2 cursor-pointer disabled:cursor-not-allowed"
                            >
                              Remove
                            </Button>
                          </div>
                        </div>

                        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(220px,1fr)_420px]">
                          <Input
                            size="sm"
                            label="Tab label"
                            aria-label={`Agent ${index + 1} label`}
                            value={agent.label}
                            disabled={saving}
                            onChange={(event) => updateAgent(agent.id, { label: event.target.value })}
                            className="w-full min-w-0"
                          />
                          <Field label="Model & reasoning">
                            <div className="grid min-w-0 grid-cols-[270px_150px] overflow-hidden rounded-md ring ring-kumo-line focus-within:ring-kumo-focus/50">
                              <Select<string>
                                aria-label={`${agent.label} model`}
                                size="sm"
                                value={agent.routeKey}
                                disabled={saving}
                                onValueChange={(value) => { if (value) chooseRoute(agent, value); }}
                                renderValue={(value) => routesByKey.get(value)?.label ?? value}
                                className="w-full min-w-0 rounded-none bg-transparent ring-0 focus:ring-0"
                              >
                                {routes.map((option) => (
                                  <Select.Option key={option.key} value={option.key} disabled={!option.available}>{option.label}</Select.Option>
                                ))}
                              </Select>
                              <Select<PlannerEffort>
                                aria-label={`${agent.label} reasoning`}
                                size="sm"
                                value={agent.effort}
                                disabled={saving}
                                onValueChange={(effort) => { if (effort) updateAgent(agent.id, { effort }); }}
                                renderValue={(effort) => EFFORT_LABELS[effort]}
                                className="w-full rounded-none border-l border-kumo-line bg-transparent ring-0 focus:ring-0"
                              >
                                {(route?.supportedEfforts ?? []).map((effort) => (
                                  <Select.Option key={effort} value={effort}>{EFFORT_LABELS[effort]}</Select.Option>
                                ))}
                              </Select>
                            </div>
                          </Field>
                        </div>

                        <div className="mt-3">
                          <Textarea
                            size="sm"
                            label="Role instructions"
                            aria-label={`Agent ${index + 1} instructions`}
                            value={agent.instructions}
                            disabled={saving}
                            onChange={(event) => updateAgent(agent.id, { instructions: event.target.value })}
                            rows={3}
                            className="w-full resize-y text-xs leading-5"
                          />
                        </div>
                      </LayerCard>
                    );
                  })}
                </div>
              </section>

              {error && <div role="alert" className="rounded border border-kumo-danger/30 bg-kumo-danger/5 px-3 py-2 text-xs text-kumo-danger">{error}</div>}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-kumo-line px-4 py-3">
          <div>
            {selected && (
              <Button type="button" size="sm" variant="secondary-destructive" disabled={saving} onClick={() => void removeOrReset()}>
                {selected.origin === "builtin" ? "Reset" : "Delete"}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="button" size="sm" variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save skill"}
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
