import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.resolve(__dirname, "..", "manifest.json");

// The checked-in compatibility manifest should describe the production
// submission endpoint, even when a developer's local .env points at ngrok.
process.env.LETTER_IRL_PUBLIC_BASE_URL = "https://api.letterirl.com";

// And the tools production lists: arrival dates (#535) stay off there until
// the owner's word, whatever a developer's .env turns on. Set before the
// import below, whose dotenv/config leaves a variable already set alone.
process.env.LETTER_IRL_ARRIVE_BY_ENABLED = "false";
// Stationery (#563) likewise.
process.env.LETTER_IRL_STATIONERY_ENABLED = "false";
// And room to write (#586).
process.env.LETTER_IRL_ROOM_TO_WRITE_ENABLED = "false";
// And the 4x6 and 11x6 postcards (#594).
process.env.LETTER_IRL_POSTCARD_SIZES_ENABLED = "false";

const { stringifyManifest } = await import("../src/mcp/manifest.js");

fs.writeFileSync(manifestPath, stringifyManifest(), "utf-8");
console.log(`Wrote manifest snapshot to ${manifestPath}`);
