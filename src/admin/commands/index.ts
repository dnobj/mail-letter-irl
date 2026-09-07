import { createAccountCommands } from "./accounts.js";
import { alertTransitionCommand } from "./alerts.js";
import { createImageCommands } from "./images.js";
import { jobResolveCommand, jobRetryCommand } from "./jobs.js";
import { createPromoCommands } from "./promos.js";
import type { CommandDefinition } from "./runner.js";
import { createStripeCommands } from "./stripe.js";

const stripe = createStripeCommands();
const accounts = createAccountCommands();
const promos = createPromoCommands();
const images = createImageCommands();

/** Every command the panel can run, keyed by route name. */
export const ADMIN_COMMANDS: ReadonlyArray<CommandDefinition<any>> = [
  alertTransitionCommand,
  jobResolveCommand,
  jobRetryCommand,
  stripe.refundLetters,
  stripe.repairGrant,
  accounts.unblockSends,
  accounts.adjustBalance,
  accounts.grantImages,
  accounts.releaseQuarantine,
  promos.create,
  promos.transition,
  promos.remove,
  images.resolve,
];

export function findAdminCommand(name: string): CommandDefinition<any> | undefined {
  return ADMIN_COMMANDS.find((command) => command.name === name);
}
