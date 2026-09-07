import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderError } from "../../../src/admin/pages/error.js";
import { escapeHtml, html, join as joinHtml, raw } from "../../../src/admin/ui/html.js";
import { formatMoney, formatRelative, maskEmailForTest, statusBadge } from "./formatHelpers.js";
import { renderPage } from "../../../src/admin/ui/layout.js";

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

describe("admin html template", () => {
  it("escapes every interpolation unless it is already safe markup", () => {
    const hostile = `<script>alert("x")</script>&'`;
    const rendered = html`<p title="${hostile}">${hostile}</p>`.value;
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
    expect(html`<b>${raw("<i>ok</i>")}</b>`.value).toBe("<b><i>ok</i></b>");
    expect(html`<b>${html`<i>${"<x>"}</i>`}</b>`.value).toBe("<b><i>&lt;x&gt;</i></b>");
    expect(html`${[html`<i>a</i>`, "<b>"]}`.value).toBe("<i>a</i>&lt;b&gt;");
    expect(html`${null}${undefined}${false}${0}`.value).toBe("0");
    expect(joinHtml([html`a`, html`b`], ", ").value).toBe("a, b");
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("renders the shell with the nonce on the stylesheet and the script only", () => {
    const page = renderPage({
      title: "T<>",
      nonce: "NONCE123",
      banner: {
        environment: "production",
        mode: "read-only",
        marker: "production",
        databaseRole: "letter_irl_admin_reader_production",
        stripeKeyMode: "live",
        stripeKeyRestricted: true,
        letterProvider: "postgrid",
        buildCommit: "abcdef1234567890",
        nodeName: "letter-irl-admin-prod.tail1234.ts.net",
        tag: "tag:prod-admin",
      },
      nav: [{ href: "/", label: "Overview" }],
      currentPath: "/",
      actor: { id: "owner@example.com", name: "<Owner>", node: "laptop.tail1234.ts.net" },
      csrfToken: "c".repeat(64),
      scriptPath: "/assets/client-abc.js",
      flash: { tone: "ok", text: "<done>" },
      elevatedUntil: null,
      body: html`<h1>${"<body>"}</h1>`,
    });
    expect(page).toContain('<style nonce="NONCE123">');
    expect(page).toContain('<script nonce="NONCE123" src="/assets/client-abc.js" defer></script>');
    expect(page.match(/nonce="/g)).toHaveLength(2);
    expect(page).toContain("&lt;body&gt;");
    expect(page).toContain("&lt;done&gt;");
    expect(page).toContain("T&lt;&gt;");
    expect(page).toContain('aria-current="page"');
    expect(page).toContain("banner-production");
    expect(page).toContain("live (restricted)");
    expect(page).not.toContain("<h1><body></h1>");
  });

  it("renders error pages with the correlation id and nothing else", () => {
    const page = renderError({
      status: 500,
      code: "ADMIN_INTERNAL_ERROR",
      message: "The admin operation failed.",
      correlationId: "11111111-1111-1111-1111-111111111111",
    }).value;
    expect(page).toContain("500");
    expect(page).toContain("11111111-1111-1111-1111-111111111111");
    expect(page).not.toMatch(/stack|SQL|password/i);
  });

  it("formats money, relative time, badges and masked emails", () => {
    expect(formatMoney(1999, "usd")).toBe("19.99 USD");
    expect(formatMoney(-5, "USD")).toBe("-0.05 USD");
    expect(formatMoney(500, "jpy")).toBe("500 JPY");
    expect(formatMoney(null, "usd")).toBe("—");
    expect(formatRelative(new Date(1_000), 61_000)).toBe("1m ago");
    expect(statusBadge("failed").value).toContain("badge-bad");
    expect(statusBadge("fulfilled").value).toContain("badge-ok");
    expect(statusBadge("<x>").value).not.toContain("<x>");
    expect(maskEmailForTest("john.doe@example.com")).toBe("j***@example.com");
    expect(maskEmailForTest("jo@example.com")).toBe("***@example.com");
    expect(maskEmailForTest(null)).toBe("(none)");
  });

  it("keeps the panel free of innerHTML, eval and document.write, and the client script free of network calls", async () => {
    const forbidden = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/;
    for await (const file of walk(join(process.cwd(), "src", "admin"))) {
      const source = await readFile(file, "utf8");
      // The template module documents the rule in a comment; strip comments
      // before matching so the rule can be stated where it is enforced.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(forbidden);
    }
    const client = await readFile(join(process.cwd(), "src", "admin", "ui", "client.ts"), "utf8");
    expect(client).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|import\s|require\(/);
  });
});
