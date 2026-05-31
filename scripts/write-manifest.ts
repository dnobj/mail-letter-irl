import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.resolve(__dirname, "..", "manifest.json");

// The checked-in compatibility manifest should describe the production
// submission endpoint, even when a developer's local .env points at ngrok.
process.env.LETTER_IRL_PUBLIC_BASE_URL = "https://api.letterirl.com";

const { stringifyManifest } = await import("../src/mcp/manifest.js");

fs.writeFileSync(manifestPath, stringifyManifest(), "utf-8");
console.log(`Wrote manifest snapshot to ${manifestPath}`);
