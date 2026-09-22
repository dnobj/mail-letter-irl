/**
 * get_profile (#424).
 *
 * The tool ChatGPT calls to identify a connected account. The contract it has
 * to keep, from OpenAI's Plugins auth guidance: an `id` that is unique within
 * the app and unchanged across token refresh, reconnection and scope upgrades;
 * and on any failure "the appropriate auth error instead of a placeholder ID
 * or another account's profile".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../../../src/contracts/types.js";

vi.mock("../../../src/services/userService.js", () => ({
  findUser: vi.fn()
}));

import { findUser } from "../../../src/services/userService.js";
import { getProfileTool } from "../../../src/tools/getProfile.js";

const mockFindUser = findUser as ReturnType<typeof vi.fn>;

const context = (userId: string): ToolContext => ({
  user: { userId, creditsRemaining: 0, orders: [] } as any,
  correlationId: "test-correlation-id",
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
  now: () => new Date("2026-09-22T00:00:00Z"),
  persist: vi.fn()
});

describe("get_profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is discoverable by the marker ChatGPT looks for, and by nothing else", () => {
    // "The marker tells OpenAI which tool supplies profile information." It is
    // found by _meta, not by name, so the name is free but the marker is not.
    expect(getProfileTool.meta["openai/profile"]).toBe(true);
    expect(getProfileTool.readOnly).toBe(true);
    expect(getProfileTool.meta.readOnlyHint).toBe(true);
  });

  it("takes no arguments and publishes an output schema requiring id", () => {
    expect(getProfileTool.inputSchema).toEqual({ type: "object", properties: {} });
    expect(getProfileTool.outputSchema).toMatchObject({ type: "object", required: ["id"] });
  });

  it("returns the account row's own key as the id, with the confirmed address", async () => {
    mockFindUser.mockResolvedValue({
      user_id: "google-oauth2|100",
      email: "person@example.com"
    });
    const out = await getProfileTool.handler({}, context("google-oauth2|100"));
    expect(out).toEqual({ id: "google-oauth2|100", email: "person@example.com" });
    expect(mockFindUser).toHaveBeenCalledWith("google-oauth2|100");
  });

  it("keeps the id stable across calls for the same account", async () => {
    // Refresh, reconnect and a scope upgrade all present the same subject;
    // the id must not depend on anything that changes between them.
    mockFindUser.mockResolvedValue({ user_id: "auth0|abc", email: "a@example.com" });
    const first = await getProfileTool.handler({}, context("auth0|abc"));
    const second = await getProfileTool.handler({}, context("auth0|abc"));
    expect(second.id).toBe(first.id);
  });

  it("never returns a placeholder or another account's profile when the row is missing", async () => {
    mockFindUser.mockResolvedValue(null);
    await expect(getProfileTool.handler({}, context("auth0|missing"))).rejects.toThrow(
      /confirmed email address/
    );
  });

  it("omits email rather than inventing one when the row has none", async () => {
    mockFindUser.mockResolvedValue({ user_id: "auth0|noemail", email: null });
    const out = await getProfileTool.handler({}, context("auth0|noemail"));
    expect(out).toEqual({ id: "auth0|noemail" });
    expect("email" in out).toBe(false);
  });
});
