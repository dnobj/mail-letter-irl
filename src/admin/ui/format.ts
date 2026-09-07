import { html, type SafeHtml } from "./html.js";

/** Display helpers. Everything returns escaped markup or plain strings. */

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

export function formatRelative(
  value: Date | string | null | undefined,
  now = Date.now(),
): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  const seconds = Math.round((now - date.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const suffix = seconds >= 0 ? "ago" : "from now";
  if (abs < 60) return `${abs}s ${suffix}`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ${suffix}`;
  if (abs < 86_400) return `${Math.round(abs / 3600)}h ${suffix}`;
  return `${Math.round(abs / 86_400)}d ${suffix}`;
}

const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function formatMoney(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const code = (currency ?? "usd").toLowerCase();
  if (ZERO_DECIMAL.has(code)) return `${cents} ${code.toUpperCase()}`;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${code.toUpperCase()}`;
}

export function creditsToLetters(credits: number): string {
  const whole = Math.floor(credits / 2);
  return credits % 2 === 0 ? `${whole}` : `${whole}½`;
}

export function statusBadge(status: string | null | undefined): SafeHtml {
  const text = status ?? "—";
  const tone =
    /^(fulfilled|completed|succeeded|accepted|delivered|active|resolved|won|processed|running)$/.test(text)
      ? "ok"
      : /^(failed|lost|disputed|revoked|rejected|denied|critical|exited|unmatched|held|compensated)$/.test(text)
        ? "bad"
        : /^(pending|processing|queued|paid|fulfillment_pending|refund_pending|open|acknowledged|warning|stripe_pending|letters_revoked|reserved|dispatched|ambiguous)$/.test(text)
          ? "warn"
          : "muted";
  return html`<span class="badge badge-${tone}">${text}</span>`;
}

export function yesNo(value: boolean | null | undefined): string {
  return value ? "yes" : "no";
}

export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}
