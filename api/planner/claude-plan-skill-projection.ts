import type { AgentSkillDefinition } from "../coordination";
import { sha256Hex } from "./plan-writer-contract";

// Projected skills must never shadow provider-owned commands or the
// conversation-replacement commands that terminate a managed generation.
const CLAUDE_NATIVE_COMMANDS = new Set([
  "agents", "branch", "clear", "compact", "config", "cost", "doctor", "exit",
  "export", "fork", "help", "hooks", "ide", "login", "logout", "mcp", "memory",
  "model", "new", "permissions", "plugin", "release-notes", "rename", "resume",
  "review", "status", "terminal-setup", "theme", "vim",
]);

export function validateClaudePlanSkillProjection(skills: AgentSkillDefinition[]): AgentSkillDefinition[] {
  const seen = new Set<string>();
  for (const skill of skills) {
    const command = skill.command.trim().replace(/^\/+/, "").toLowerCase();
    if (!command || !/^[a-z0-9-]+$/u.test(command)) throw new Error(`Invalid Plan Skill command: ${skill.command}`);
    if (CLAUDE_NATIVE_COMMANDS.has(command)) throw new Error(`Plan Skill /${command} collides with a native Claude command.`);
    if (seen.has(command)) throw new Error(`Duplicate projected Plan Skill command: /${command}`);
    seen.add(command);
  }
  return skills;
}

export async function claudePlanSkillProjectionRevision(skills: AgentSkillDefinition[]): Promise<string> {
  return await sha256Hex(JSON.stringify(skills));
}
