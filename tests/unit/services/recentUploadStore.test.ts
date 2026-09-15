import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #282: an uploaded image's capability URL must not outlive its use.
 *
 * The SQL assertions pin WHOLE statements after normalising whitespace. A
 * fragment such as "updated_at" or "make_interval" survives the mutations that
 * matter here - a flipped comparison, a dropped cast, a widened window - so it
 * proves nothing. What these unit tests cannot prove is that PostgreSQL agrees
 * with the predicate; tests/integration/recentUploadsSweep.postgres.test.ts does.
 */

const db = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock("../../../src/db/index.js", () => ({
  query: db.query
}));

import {
  RECENT_UPLOAD_PURGE_AFTER_HOURS,
  RECENT_UPLOAD_TTL_MAX_MS,
  clearRecentUploadedImages,
  getRecentUploadCount,
  getRecentUploadedImage,
  pruneExpiredRecentUploads,
  purgeExpiredRecentUploads,
  recentUploadTtlMs,
  setRecentUploadedImage
} from "../../../src/services/recentUploadStore.js";

const normalise = (sql: string) => sql.replace(/\s+/g, " ").trim();

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const URL_A = "https://files.oaiusercontent.com/file-aaa";
const URL_B = "https://files.oaiusercontent.com/file-bbb";

describe("recentUploadStore retention (#282)", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    clearRecentUploadedImages();
  });

  afterEach(() => {
    clearRecentUploadedImages();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("purgeExpiredRecentUploads", () => {
    it("deletes rows 24 hours after their last update, in one whole statement", async () => {
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 3 });

      await expect(purgeExpiredRecentUploads()).resolves.toBe(3);

      expect(db.query).toHaveBeenCalledTimes(1);
      const [sql, params] = db.query.mock.calls[0];
      expect(normalise(sql)).toBe(
        "DELETE FROM recent_uploads WHERE updated_at < NOW() - make_interval(hours => $1::int)"
      );
      expect(params).toEqual([24]);
      expect(sql).not.toMatch(/RETURNING/i);
      expect(sql).not.toMatch(/image_url/);
    });

    it("reports zero when the driver gives no row count", async () => {
      db.query.mockResolvedValueOnce({ rows: [], rowCount: null });

      await expect(purgeExpiredRecentUploads()).resolves.toBe(0);
    });
  });

  describe("recentUploadTtlMs", () => {
    // Each fallback is 3600000, which differs from what the old
    // Number(process.env...) produced for the same input: NaN for 'abc' and
    // '', 1000 for '1e3', and the raw value for anything over the cap.
    it.each([
      ["unset", undefined, HOUR_MS],
      ["a valid value", "7200000", 7_200_000],
      ["the cap itself", String(6 * HOUR_MS), 6 * HOUR_MS],
      ["a word", "abc", HOUR_MS],
      ["an empty string", "", HOUR_MS],
      ["a truncated exponent", "1e3", HOUR_MS],
      ["one millisecond over the cap", String(6 * HOUR_MS + 1), HOUR_MS],
      ["under the one-minute minimum", "59999", HOUR_MS]
    ])("%s gives the expected window", (_label, raw, expected) => {
      const env = raw === undefined ? {} : { LETTER_IRL_RECENT_UPLOAD_TTL_MS: raw };

      expect(recentUploadTtlMs(env as NodeJS.ProcessEnv)).toBe(expected);
    });

    it("keeps the longest read window below the purge age, so a readable row is never deletable", () => {
      expect(RECENT_UPLOAD_TTL_MAX_MS).toBeLessThan(RECENT_UPLOAD_PURGE_AFTER_HOURS * HOUR_MS);
    });
  });

  describe("the database read", () => {
    it("uses the configured TTL as its window rather than a hard-coded hour", async () => {
      vi.stubEnv("LETTER_IRL_RECENT_UPLOAD_TTL_MS", "7200000");

      await getRecentUploadedImage("user-1", "postcard");

      expect(db.query).toHaveBeenCalledTimes(1);
      const [sql, params] = db.query.mock.calls[0];
      expect(normalise(sql)).toBe(
        "SELECT image_url, context, updated_at FROM recent_uploads WHERE user_id = $1 " +
          "AND updated_at > NOW() - make_interval(secs => $2::double precision)"
      );
      expect(params).toEqual(["user-1", 7200]);
    });

    it("reads a one-hour window when the setting is unreadable", async () => {
      vi.stubEnv("LETTER_IRL_RECENT_UPLOAD_TTL_MS", "abc");

      await getRecentUploadedImage("user-1");

      expect(db.query.mock.calls[0][1]).toEqual(["user-1", 3600]);
    });
  });

  describe("the in-process copy", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    });

    it("keeps an entry at exactly the TTL and serves it from memory", async () => {
      await setRecentUploadedImage("user-1", URL_A, "postcard");
      db.query.mockClear();

      vi.setSystemTime(Date.now() + HOUR_MS);
      const recent = await getRecentUploadedImage("user-1", "postcard");

      expect(recent?.imageUrl).toBe(URL_A);
      expect(db.query).not.toHaveBeenCalled();
    });

    it("prunes an entry one millisecond past the TTL, so the read goes to the database", async () => {
      await setRecentUploadedImage("user-1", URL_A, "postcard");
      db.query.mockClear();

      vi.setSystemTime(Date.now() + HOUR_MS + 1);
      const recent = await getRecentUploadedImage("user-1", "postcard");

      expect(recent).toBeNull();
      expect(db.query).toHaveBeenCalledTimes(1);
      expect(getRecentUploadCount()).toBe(0);
    });

    it("prunes only the entries that have expired", async () => {
      await setRecentUploadedImage("user-old", URL_A, "postcard");
      vi.setSystemTime(Date.now() + 30 * MINUTE_MS);
      await setRecentUploadedImage("user-new", URL_B, "postcard");

      // 61 minutes after the first upload, 31 minutes after the second.
      vi.setSystemTime(Date.now() + 31 * MINUTE_MS);
      pruneExpiredRecentUploads();

      expect(getRecentUploadCount()).toBe(1);
      db.query.mockClear();
      await expect(getRecentUploadedImage("user-new", "postcard")).resolves.toMatchObject({
        imageUrl: URL_B
      });
      expect(db.query).not.toHaveBeenCalled();
    });

    it("starts no timer until the first upload, and stops it when cleared", async () => {
      expect(vi.getTimerCount()).toBe(0);

      await setRecentUploadedImage("user-1", URL_A);
      expect(vi.getTimerCount()).toBe(1);

      await setRecentUploadedImage("user-2", URL_B);
      expect(vi.getTimerCount()).toBe(1);

      clearRecentUploadedImages();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("prunes on its timer when nothing calls the store", async () => {
      await setRecentUploadedImage("user-1", URL_A, "postcard");
      expect(getRecentUploadCount()).toBe(1);

      // The timer fires every five minutes. At exactly the TTL the entry stays.
      vi.advanceTimersByTime(HOUR_MS);
      expect(getRecentUploadCount()).toBe(1);

      // The next tick is five minutes past the TTL, and removes it.
      vi.advanceTimersByTime(5 * MINUTE_MS);
      expect(getRecentUploadCount()).toBe(0);
    });

    it("prunes other users' expired entries on every read", async () => {
      await setRecentUploadedImage("user-old", URL_A, "postcard");

      // setSystemTime fires no timers, so only the read itself can prune.
      vi.setSystemTime(Date.now() + HOUR_MS + 1);
      await getRecentUploadedImage("user-other", "postcard");

      expect(getRecentUploadCount()).toBe(0);
    });

    it("prunes expired entries on every upload", async () => {
      await setRecentUploadedImage("user-old", URL_A, "postcard");

      vi.setSystemTime(Date.now() + HOUR_MS + 1);
      await setRecentUploadedImage("user-new", URL_B, "postcard");

      expect(getRecentUploadCount()).toBe(1);
    });

    it("starts the timer when a database read fills the cache, so that copy is pruned too", async () => {
      // Review round 1: only an upload started the timer, so a copy loaded by a
      // read on an instance nobody uploaded to stayed in memory indefinitely.
      db.query.mockResolvedValueOnce({
        rows: [
          { image_url: URL_A, context: "postcard", updated_at: new Date(Date.now() - 5 * MINUTE_MS) }
        ],
        rowCount: 1
      });

      await expect(getRecentUploadedImage("user-1", "postcard")).resolves.toMatchObject({
        imageUrl: URL_A
      });
      expect(getRecentUploadCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      // 55 minutes on, the upload is exactly an hour old and stays.
      vi.advanceTimersByTime(55 * MINUTE_MS);
      expect(getRecentUploadCount()).toBe(1);
      // The next tick is 65 minutes after the upload, and removes it.
      vi.advanceTimersByTime(5 * MINUTE_MS);
      expect(getRecentUploadCount()).toBe(0);
    });

    it("caches a database row with its own upload time, not the time it was read", async () => {
      db.query
        .mockResolvedValueOnce({
          rows: [
            { image_url: URL_A, context: "postcard", updated_at: new Date(Date.now() - 59 * MINUTE_MS) }
          ],
          rowCount: 1
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(getRecentUploadedImage("user-1", "postcard")).resolves.toMatchObject({
        imageUrl: URL_A
      });

      // Two minutes later the upload is 61 minutes old, so the cached copy must
      // not answer: the read goes back to the database, which has nothing.
      vi.setSystemTime(Date.now() + 2 * MINUTE_MS);
      await expect(getRecentUploadedImage("user-1", "postcard")).resolves.toBeNull();
      expect(db.query).toHaveBeenCalledTimes(2);
    });
  });
});
