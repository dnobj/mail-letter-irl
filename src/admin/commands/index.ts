import { alertTransitionCommand } from "./alerts.js";
import { jobResolveCommand, jobRetryCommand } from "./jobs.js";
import type { CommandDefinition } from "./runner.js";

/** Every command the panel can run, keyed by route name. */
export const ADMIN_COMMANDS: ReadonlyArray<CommandDefinition<any>> = [
  alertTransitionCommand,
  jobResolveCommand,
  jobRetryCommand,
];

export function findAdminCommand(name: string): CommandDefinition<any> | undefined {
  return ADMIN_COMMANDS.find((command) => command.name === name);
}
