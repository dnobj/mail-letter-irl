import { addressRequestTokenHash } from "../../services/addressRequestService.js";
import { AdminFoundationError } from "../errors.js";
import type { AdminJsonObject } from "../contracts.js";
import { type CommandDefinition } from "./runner.js";

/**
 * address_request.delete (#701): delete an address request, and any address
 * given with it, when the person it was sent to (or its sender) asks.
 *
 * The panel never reads address requests: they hold a third party's name and
 * address, and neither role is granted their content (provisioning.ts, 049).
 * So the request is named by what the asker can give, never by what it holds:
 * its link's fingerprint (`link:` and the SHA-256 of the link's token, the hash
 * the request is stored under), or its id (`request:` and the uuid, which the
 * sender's get_address_request shows). The preview cannot say whether it
 * exists; the delete reads back only its status and when it was made, and the
 * result says whether one was found.
 */

const LINK_TARGET = /^link:[0-9a-f]{64}$/;
const REQUEST_TARGET = /^request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The target for a pasted address-request link (`…/address#<token>`) or its
 * bare token, or a request id; null for anything else. A link is reduced to
 * its fingerprint here, so the token never reaches a URL, the audit or a
 * command run.
 */
export function addressRequestTarget(pasted: string): string | null {
  const text = pasted.trim();
  const id = text.toLowerCase();
  if (REQUEST_TARGET.test(`request:${id}`)) return `request:${id}`;
  const token = text.includes("#") ? text.slice(text.lastIndexOf("#") + 1) : text;
  const hash = addressRequestTokenHash(token);
  return hash ? `link:${hash.toString("hex")}` : null;
}

/** Where the Support page's form goes for a pasted link or id: the delete's preview, by fingerprint. */
export function addressRequestPreviewPath(pasted: string): string | null {
  const target = addressRequestTarget(pasted);
  return target ? `/commands/address_request.delete/preview?target=${encodeURIComponent(target)}` : null;
}

export const addressRequestDeleteCommand: CommandDefinition<Record<string, never>> = {
  name: "address_request.delete",
  title: "Delete address request",
  action: "address_request.delete",
  targetType: "address_request",
  transactional: true,
  verb: () => "DELETE-ADDRESS-REQUEST",
  parseInput: () => ({}),
  async preview(_client, targetId) {
    const target = targetId.trim().toLowerCase();
    if (!LINK_TARGET.test(target) && !REQUEST_TARGET.test(target)) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    const byLink = target.startsWith("link:");
    return {
      targetId: target,
      summary: { by: byLink ? "link" : "request" },
      display: [
        ["Address request", byLink ? `the one whose link has the fingerprint ${target.slice(5, 17)}…` : target.slice(8)],
        ["Named by", byLink ? "its link" : "its id"],
      ],
      warnings: [
        "Keep the link, names and address out of the reason: the audit keeps it for two years. Write who asked and how, such as \"the recipient, by email\".",
        "The panel cannot read address requests, so this preview cannot say whether one exists: the result says whether one was found and deleted.",
        "Deletion is permanent: the request and any address given with it go. A letter already previewed or mailed with that address keeps its own copy, on the letter's schedule.",
      ],
    };
  },
  async execute(execution, targetId) {
    if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
    const target = targetId.trim().toLowerCase();
    if (!LINK_TARGET.test(target) && !REQUEST_TARGET.test(target)) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    const byLink = target.startsWith("link:");
    // Reads back only the status and the time it was made: never the names or the address.
    const deleted = await execution.client.query<{ status: string; created_at: Date }>(
      byLink
        ? "DELETE FROM address_requests WHERE token_hash = decode($1, 'hex') RETURNING status, created_at"
        : "DELETE FROM address_requests WHERE request_id = $1::uuid RETURNING status, created_at",
      [target.slice(byLink ? 5 : 8)],
    );
    const row = deleted.rows[0];
    const outcome: AdminJsonObject = row
      ? { deleted: true, status: row.status, createdAt: new Date(row.created_at).toISOString() }
      : { deleted: false };
    return outcome;
  },
};
