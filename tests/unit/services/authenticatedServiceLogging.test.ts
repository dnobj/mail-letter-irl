import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/index.js", () => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("../../../src/services/providers/index.js", () => ({
  getLetterProvider: vi.fn()
}));

import { query, transaction } from "../../../src/db/index.js";
import { getLetterProvider } from "../../../src/services/providers/index.js";
import {
  clearReturnAddress,
  setReturnAddress
} from "../../../src/services/returnAddressService.js";
import { addCreditsToLedger } from "../../../src/services/creditLedgerService.js";

const subject = "auth0|financial-address-subject";
const originalStreet = "123 Private Street";
const correctedStreet = "123 PRIVATE ST";

function captured(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join("\n");
}

describe("authenticated service diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not log a subject or address on save, correction, or clear", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    vi.mocked(getLetterProvider).mockReturnValue({
      validateAddress: vi.fn().mockResolvedValue({
        status: "corrected",
        verifiedAddress: {
          line1: correctedStreet,
          city: "Private City",
          state: "IL",
          postalCode: "60601",
          country: "US"
        }
      })
    } as never);

    await setReturnAddress(subject, {
      name: "Private Person",
      addressLine1: originalStreet,
      city: "Private City",
      state: "Illinois",
      postalCode: "60601-1234",
      country: "US"
    });
    await clearReturnAddress(subject);

    const output = captured(log);
    expect(output).toContain('"event":"address.auto_corrected"');
    expect(output).toContain('"event":"address.saved"');
    expect(output).toContain('"event":"address.cleared"');
    for (const sensitive of [subject, originalStreet, correctedStreet, "Private City", "60601"]) {
      expect(output).not.toContain(sensitive);
    }
  });

  it("does not log a subject or source identifier on a real ledger operation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(transaction).mockImplementation(async (callback) => callback({
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: subject, credits: 10 }] })
        .mockResolvedValueOnce({ rows: [{ ledger_id: "private-ledger", initial_amount: 5 }] })
        .mockResolvedValueOnce({ rows: [{ transaction_id: "private-transaction", amount: 5 }] })
    } as never));

    await addCreditsToLedger({
      userId: subject,
      email: "private@example.com",
      credits: 5,
      sourceType: "purchase",
      sourceReferenceId: "private-payment-reference"
    });

    const output = captured(log);
    expect(output).toContain('"event":"credits.ledger_added"');
    for (const sensitive of [subject, "private@example.com", "private-payment-reference", "private-ledger"]) {
      expect(output).not.toContain(sensitive);
    }
  });
});
