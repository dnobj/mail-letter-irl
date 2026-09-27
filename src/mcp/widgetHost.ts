import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The card host bridge (#474), inlined into each card that asks for it.
 *
 * A card marks the spot with HOST_BRIDGE_PLACEHOLDER. The server replaces the
 * marker with widgets/shared/host.js in a <script> tag, so every card stays a
 * single self-contained page that works in ChatGPT through window.openai and
 * in Claude or VS Code through MCP Apps. A card without the marker is served
 * unchanged.
 */
export const HOST_BRIDGE_PLACEHOLDER = "<!-- letter-irl:host -->";

let cachedBridge: { dir: string; source: string } | undefined;

/** The bridge script, read once per widget directory. */
export function hostBridgeSource(widgetDir: string): string {
  if (cachedBridge?.dir !== widgetDir) {
    cachedBridge = {
      dir: widgetDir,
      source: readFileSync(path.join(widgetDir, "shared", "host.js"), "utf-8")
    };
  }
  return cachedBridge.source;
}

/**
 * The card as served: the bridge inlined where the card asks for it. A
 * `</script` inside the bridge would end the tag early; the bridge has none,
 * and this refuses to serve one rather than break the page quietly.
 */
export function inlineHostBridge(html: string, widgetDir: string): string {
  if (!html.includes(HOST_BRIDGE_PLACEHOLDER)) return html;
  const source = hostBridgeSource(widgetDir);
  if (/<\/script/i.test(source)) {
    throw new Error("widgets/shared/host.js must not contain a closing script tag");
  }
  if (source.includes(HOST_BRIDGE_PLACEHOLDER)) {
    throw new Error("widgets/shared/host.js must not contain the card's marker comment");
  }
  return html.replace(HOST_BRIDGE_PLACEHOLDER, () => `<script>\n${source}\n    </script>`);
}
