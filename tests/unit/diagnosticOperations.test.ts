import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDatabaseFailure } from "../../src/db/index.js";
import { writeMigrationFailure } from "../../src/cli/migrate.js";
import { writeMaintenanceFailure } from "../../src/cli/runMaintenance.js";

describe("operational diagnostic classification", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [writeDatabaseFailure, "database.query_failed", "23505"],
    [writeMigrationFailure, "database.migration_failed", "42P01"],
    [writeMaintenanceFailure, "maintenance.run_failed", "ETIMEDOUT"]
  ] as const)("keeps safe codes and redacts messages", (writeFailure, event, code) => {
    const sensitive = "postgres://user:password@private/db auth0|private";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = Object.assign(new Error(sensitive), { code, stack: sensitive });

    if (writeFailure === writeDatabaseFailure) writeFailure(event, failure);
    else writeFailure(failure);

    const output = error.mock.calls.flat().map(String).join("\n");
    expect(output).toContain(`"errorClass":"${code}"`);
    expect(output).toContain(`"event":"${event}"`);
    expect(output).not.toContain(sensitive);
  });
});
