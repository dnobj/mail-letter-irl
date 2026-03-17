import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyManifest } from "../src/mcp/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.resolve(__dirname, "..", "manifest.json");

fs.writeFileSync(manifestPath, stringifyManifest(), "utf-8");
console.log(`Wrote manifest snapshot to ${manifestPath}`);
