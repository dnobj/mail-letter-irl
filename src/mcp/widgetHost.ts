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
/**
 * Where a card asks for widgets/shared/pages.js (#534): our renderer's pages
 * and the cleaner that keeps a card safe from them, one source for the letter
 * and postcard cards.
 */
export const PAGES_PLACEHOLDER = "<!-- letter-irl:pages -->";

/** The shared scripts a card may ask for: each marker, and the file put there. */
const SHARED_SCRIPTS = [
  { marker: HOST_BRIDGE_PLACEHOLDER, file: "host.js" },
  { marker: PAGES_PLACEHOLDER, file: "pages.js" }
] as const;

const cachedSources = new Map<string, string>();

/** A shared script, read once per widget directory. */
function sharedScriptSource(widgetDir: string, file: string): string {
  const key = path.join(widgetDir, "shared", file);
  let source = cachedSources.get(key);
  if (source === undefined) {
    source = readFileSync(key, "utf-8");
    cachedSources.set(key, source);
  }
  return source;
}

/** The bridge script, read once per widget directory. */
export function hostBridgeSource(widgetDir: string): string {
  return sharedScriptSource(widgetDir, "host.js");
}

/**
 * The card as served: the bridge, and any other shared script, inlined where
 * the card asks for it. A `</script` inside a script would end the tag early,
 * and a `<!--` followed by `<script` would keep it from closing at all,
 * swallowing the card's own script; none has either, and this refuses to
 * serve one rather than break the page quietly.
 */
export function inlineHostBridge(html: string, widgetDir: string): string {
  let served = html;
  for (const { marker, file } of SHARED_SCRIPTS) {
    if (!served.includes(marker)) continue;
    const source = sharedScriptSource(widgetDir, file);
    if (/<\/script/i.test(source)) {
      throw new Error(`widgets/shared/${file} must not contain a closing script tag`);
    }
    if (SHARED_SCRIPTS.some(script => source.includes(script.marker))) {
      throw new Error(`widgets/shared/${file} must not contain the card's marker comment`);
    }
    if (source.includes("<!--")) {
      throw new Error(`widgets/shared/${file} must not contain an HTML comment opener`);
    }
    served = served.replace(marker, () => `<script>\n${source}\n    </script>`);
  }
  return served;
}
