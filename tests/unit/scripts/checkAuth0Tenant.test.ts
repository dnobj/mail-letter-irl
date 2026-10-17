import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ACTION_FILES,
  checkLinkingGrant,
  checkPostLoginFlow,
  codeHash,
  countApplications,
  normalizeCode,
} from "../../../scripts/check-auth0-tenant.js";

/**
 * The read-only Auth0 tenant check (#702): the Actions are recognised by their
 * code, not their names, so a deployed copy that differs from the repository's
 * file in anything but whitespace is reported, and so is the wrong order.
 */

const link = readFileSync(ACTION_FILES.link, "utf8");
const claim = readFileSync(ACTION_FILES.claim, "utf8");
const expected = { link: codeHash(link), claim: codeHash(claim) };

function linking(overrides: Record<string, unknown> = {}) {
  return {
    name: "Link verified email",
    code: link,
    allChangesDeployed: true,
    dependencies: [{ name: "auth0", version: "7.2.0" }],
    secretNames: ["AUTH0_DOMAIN", "LINKING_CLIENT_ID", "LINKING_CLIENT_SECRET"],
    ...overrides,
  };
}

function claiming(overrides: Record<string, unknown> = {}) {
  return { name: "Email claim", code: claim, allChangesDeployed: true, dependencies: [], secretNames: [], ...overrides };
}

const failures = (results: Array<{ ok: boolean; line: string }>) => results.filter((result) => !result.ok).map((result) => result.line);

describe("the Post Login flow", () => {
  it("passes both Actions deployed as the files, linking first", () => {
    expect(failures(checkPostLoginFlow([linking(), claiming()], expected))).toEqual([]);
  });

  it("ignores line endings and trailing whitespace, and nothing else", () => {
    // A checkout with core.autocrlf reads the file with CRLF already.
    const windows = link.replace(/\r?\n/g, "  \r\n") + "\r\n\r\n";
    expect(normalizeCode(windows)).toBe(normalizeCode(link));
    expect(failures(checkPostLoginFlow([linking({ code: windows }), claiming()], expected))).toEqual([]);
    const edited = link.replace("10 * 60 * 1000", "5 * 60 * 1000");
    expect(failures(checkPostLoginFlow([linking({ code: edited }), claiming()], expected))).toEqual([
      'bound #1 "Link verified email": matches neither file in docs/auth0/actions',
      "the linking Action is NOT in the Post Login flow",
    ]);
  });

  it("reports the claim Action running first", () => {
    expect(failures(checkPostLoginFlow([claiming(), linking()], expected))).toEqual([
      "the email-claim Action runs BEFORE the linking Action",
    ]);
  });

  it("reports an Action missing from the flow, one not deployed, an unpinned SDK and a missing secret", () => {
    expect(failures(checkPostLoginFlow([claiming()], expected))).toEqual(["the linking Action is NOT in the Post Login flow"]);
    expect(
      failures(
        checkPostLoginFlow(
          [
            linking({
              allChangesDeployed: false,
              dependencies: [{ name: "auth0", version: "latest" }],
              secretNames: ["AUTH0_DOMAIN", "LINKING_CLIENT_ID"],
            }),
            claiming(),
          ],
          expected,
        ),
      ),
    ).toEqual([
      'bound #1 "Link verified email": has changes saved but not deployed',
      "linking Action's auth0 dependency: latest (expected 7.2.0)",
      "linking Action's secrets missing: LINKING_CLIENT_SECRET",
    ]);
  });
});

describe("the linking application's grant", () => {
  const audience = "https://tenant.example.auth0.com/api/v2/";
  const clients = [
    { client_id: "c-site", name: "Letter IRL Website", app_type: "regular_web" },
    { client_id: "c-link", name: "Account Linking (production)", app_type: "non_interactive" },
  ];

  it("passes exactly read:users and update:users on the Management API", () => {
    const grants = [{ client_id: "c-link", audience, scope: ["update:users", "read:users"] }];
    expect(failures(checkLinkingGrant(clients, grants, audience))).toEqual([]);
  });

  it("reports a wider grant, no grant, and no or two linking applications", () => {
    expect(failures(checkLinkingGrant(clients, [{ client_id: "c-link", audience, scope: ["read:users", "update:users", "delete:users"] }], audience))).toHaveLength(1);
    expect(failures(checkLinkingGrant(clients, [], audience))).toEqual(['"Account Linking (production)" has no Management API grant']);
    expect(failures(checkLinkingGrant(clients.slice(0, 1), [], audience))).toEqual(['"Account Linking" applications: 0 (expected exactly 1)']);
    expect(failures(checkLinkingGrant([...clients, { client_id: "c-2", name: "Account Linking (old)" }], [], audience))).toEqual([
      '"Account Linking" applications: 2 (expected exactly 1)',
    ]);
  });

  it("reports any other application whose Management API grant writes, and passes one that only reads", () => {
    const linkGrant = { client_id: "c-link", audience, scope: ["read:users", "update:users"] };
    const others = [...clients, { client_id: "c-check", name: "Tenant check (temporary)" }, { client_id: "c-old", name: "Old sync" }];
    expect(
      failures(checkLinkingGrant(others, [linkGrant, { client_id: "c-check", audience, scope: ["read:clients", "read:actions"] }], audience)),
    ).toEqual([]);
    expect(failures(checkLinkingGrant(others, [linkGrant, { client_id: "c-old", audience, scope: ["read:users", "update:users"] }], audience))).toEqual([
      '"Old sync" also holds a Management API grant that writes (1 of 2 scopes)',
    ]);
    expect(
      failures(checkLinkingGrant(others, [linkGrant, { client_id: "c-old", audience: "https://api.example/", scope: ["write:x"] }], audience)),
    ).toEqual([]);
  });
});

it("counts applications by type, leaving out Auth0's built-in All Applications entry", () => {
  expect(countApplications([{ app_type: "spa" }, { app_type: "regular_web" }, { app_type: "spa" }, {}, { name: "All Applications", global: true }])).toBe(
    "regular_web: 1, spa: 2, unset: 1",
  );
});
