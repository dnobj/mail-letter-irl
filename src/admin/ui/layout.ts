import { html, join, raw, type SafeHtml } from "./html.js";
import { formatDate } from "./format.js";

/**
 * The page shell: environment banner, navigation, flash, body. The stylesheet
 * is inline under the response nonce so the strict CSP needs no `unsafe-inline`.
 */

export interface BannerModel {
  environment: "development" | "production";
  mode: "read-only" | "full";
  marker: string | null;
  databaseRole: string;
  stripeKeyMode: string;
  stripeKeyRestricted: boolean;
  letterProvider: string;
  buildCommit: string;
  nodeName: string | null;
  tag: string;
}

export interface NavItem {
  href: string;
  label: string;
}

export interface FlashMessage {
  tone: "ok" | "warn" | "bad";
  text: string;
}

export interface PageShellOptions {
  title: string;
  nonce: string;
  banner: BannerModel;
  nav: NavItem[];
  currentPath: string;
  actor: { id: string; name: string; node: string } | null;
  csrfToken: string | null;
  scriptPath: string;
  flash: FlashMessage | null;
  elevatedUntil: Date | null;
  body: SafeHtml;
}

const STYLES = `
:root { color-scheme: light; --ink: #1c1c1c; --muted: #5f5f5f; --line: #d9d9d9; --paper: #fbfbfb; --card: #ffffff;
  --ok: #1b6e3a; --warn: #8a5a00; --bad: #a11d1d; --accent: #1d4f91; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible {
  outline: 3px solid #ffbf47; outline-offset: 2px; }
.banner { display: flex; flex-wrap: wrap; gap: 0.4rem 1.2rem; align-items: center; padding: 0.5rem 1rem;
  border-bottom: 4px solid; font-size: 0.9rem; }
.banner-development { background: #e8f0fb; border-color: #1d4f91; }
.banner-production { background: #fbe9e9; border-color: #a11d1d; }
.banner strong { font-size: 1rem; letter-spacing: 0.04em; text-transform: uppercase; }
.banner .mode-full { color: var(--bad); font-weight: 700; }
nav.primary { display: flex; flex-wrap: wrap; gap: 0.2rem 0.9rem; padding: 0.5rem 1rem; border-bottom: 1px solid var(--line); background: var(--card); }
nav.primary a[aria-current="page"] { font-weight: 700; text-decoration: none; }
main { padding: 1rem; max-width: 1200px; }
h1 { font-size: 1.4rem; margin: 0 0 0.75rem; }
h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; background: var(--card); }
th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: #f1f1f1; font-weight: 600; }
caption { text-align: left; font-weight: 600; padding: 0.25rem 0; }
.scroll { overflow-x: auto; }
.badge { display: inline-block; padding: 0 0.4rem; border-radius: 3px; border: 1px solid; font-size: 0.8rem; white-space: nowrap; }
.badge-ok { color: var(--ok); border-color: var(--ok); }
.badge-warn { color: var(--warn); border-color: var(--warn); }
.badge-bad { color: var(--bad); border-color: var(--bad); }
.badge-muted { color: var(--muted); border-color: var(--line); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.6rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 0.6rem 0.8rem; }
.card .n { font-size: 1.5rem; font-weight: 700; }
.card.bad .n { color: var(--bad); } .card.warn .n { color: var(--warn); }
.flash { padding: 0.6rem 0.9rem; border-left: 4px solid; margin: 0 0 1rem; background: var(--card); }
.flash-ok { border-color: var(--ok); } .flash-warn { border-color: var(--warn); } .flash-bad { border-color: var(--bad); }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; margin: 0; }
dl.kv dt { color: var(--muted); } dl.kv dd { margin: 0; overflow-wrap: anywhere; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em; overflow-wrap: anywhere; }
pre { background: #f4f4f4; padding: 0.5rem; overflow-x: auto; font-size: 0.8rem; max-height: 20rem; }
form.inline { display: inline; }
form.stack { display: grid; gap: 0.5rem; max-width: 40rem; }
label { display: block; font-weight: 600; }
input[type=text], input[type=search], input[type=number], select, textarea { width: 100%; padding: 0.4rem; border: 1px solid #888; border-radius: 3px; font: inherit; }
button { font: inherit; padding: 0.4rem 0.8rem; border-radius: 3px; border: 1px solid #555; background: #f4f4f4; cursor: pointer; }
button.danger { border-color: var(--bad); color: var(--bad); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.muted { color: var(--muted); }
.warn-text { color: var(--warn); } .bad-text { color: var(--bad); } .ok-text { color: var(--ok); }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0; }
dialog { border: 1px solid var(--line); border-radius: 4px; max-width: 32rem; }
[aria-live] { min-height: 1.2rem; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
@media (max-width: 40rem) { dl.kv { grid-template-columns: 1fr; } main { padding: 0.6rem; } }
`;

export function renderPage(options: PageShellOptions): string {
  const { banner } = options;
  const navItems = options.nav.map(
    (item) => html`<a href="${item.href}" ${
      item.href === options.currentPath ? raw('aria-current="page"') : ""
    }>${item.label}</a>`,
  );
  const document = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${options.title} · Letter IRL admin (${banner.environment})</title>
<style nonce="${options.nonce}">${raw(STYLES)}</style>
</head>
<body>
<header class="banner banner-${banner.environment}" role="banner">
  <strong>${banner.environment}</strong>
  <span class="${banner.mode === "full" ? "mode-full" : ""}">mode: ${banner.mode}</span>
  <span>marker: <code>${banner.marker ?? "missing"}</code></span>
  <span>db role: <code>${banner.databaseRole}</code></span>
  <span>stripe: <code>${banner.stripeKeyMode}${banner.stripeKeyRestricted ? " (restricted)" : ""}</code></span>
  <span>mail: <code>${banner.letterProvider}</code></span>
  <span>node: <code>${banner.nodeName ?? "local-dev"}</code> <code>${banner.tag}</code></span>
  <span>build: <code>${banner.buildCommit.slice(0, 12)}</code></span>
  ${
    options.actor
      ? html`<span>operator: <code>${options.actor.id}</code> from <code>${options.actor.node}</code></span>`
      : ""
  }
  ${
    options.elevatedUntil
      ? html`<span class="ok-text">elevated until ${formatDate(options.elevatedUntil)}</span>`
      : ""
  }
</header>
<nav class="primary" aria-label="Sections">${join(navItems)}</nav>
<main id="main">
  ${
    options.flash
      ? html`<div class="flash flash-${options.flash.tone}" role="status">${options.flash.text}</div>`
      : ""
  }
  <div aria-live="polite" id="live"></div>
  ${options.body}
</main>
<script nonce="${options.nonce}" src="${options.scriptPath}" defer></script>
</body>
</html>
`;
  return document.value;
}

/** A form field that carries the CSRF token; every POST form includes it. */
export function csrfField(token: string | null): SafeHtml {
  return token ? html`<input type="hidden" name="_csrf" value="${token}">` : html``;
}
