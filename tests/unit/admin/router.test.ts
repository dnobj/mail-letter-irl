import { describe, expect, it } from "vitest";

import { AdminRouter } from "../../../src/admin/http/router.js";

describe("admin router", () => {
  const router = new AdminRouter<string>();
  router.add("GET", "/accounts/:userId", "account");
  router.add("GET", "/accounts/search", "search");
  router.add("POST", "/accounts/:userId/reveal", "reveal");
  router.add("GET", "/", "home");

  it("prefers static routes over parameter routes regardless of registration order", () => {
    expect(router.match("GET", "/accounts/search")).toMatchObject({
      kind: "match",
      route: { handler: "search" },
    });
    expect(router.match("GET", "/accounts/auth0%7Cabc")).toMatchObject({
      kind: "match",
      route: { handler: "account" },
      params: { userId: "auth0|abc" },
    });
  });

  it("distinguishes unknown paths from wrong methods", () => {
    expect(router.match("GET", "/nope")).toEqual({ kind: "not_found" });
    expect(router.match("POST", "/accounts/u1")).toEqual({ kind: "method_not_allowed" });
    expect(router.match("GET", "/accounts/u1/reveal")).toEqual({ kind: "method_not_allowed" });
    expect(router.match("GET", "/")).toMatchObject({ kind: "match", route: { handler: "home" } });
    expect(router.match("GET", "/accounts/u1/")).toMatchObject({ kind: "match" });
  });

  it("refuses parameters that are empty, over-long, malformed or contain control characters", () => {
    expect(router.match("GET", `/accounts/${"a".repeat(256)}`)).toEqual({ kind: "not_found" });
    expect(router.match("GET", "/accounts/%ZZ")).toEqual({ kind: "not_found" });
    expect(router.match("GET", "/accounts/a%00b")).toEqual({ kind: "not_found" });
    expect(router.match("GET", "/accounts/a%20b")).toEqual({ kind: "not_found" });
    expect(router.match("GET", "/accounts/a%2Fb")).toEqual({ kind: "not_found" });
  });

  it("marks POST routes as writes unless told otherwise", () => {
    const writes = new AdminRouter<string>();
    writes.add("POST", "/x", "x");
    writes.add("POST", "/y", "y", { write: false });
    expect(writes.match("POST", "/x")).toMatchObject({ route: { write: true } });
    expect(writes.match("POST", "/y")).toMatchObject({ route: { write: false } });
  });
});
