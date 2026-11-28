import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginDir = path.resolve(__dirname, "../../../plugin");
const skillsDir = path.join(pluginDir, "skills");
const servedToolsPath = path.resolve(__dirname, "__snapshots__/servedTools.json");

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/** What a token or generic client (Hermes, OpenClaw and other skill hosts) is served, from the pinned snapshot. */
function tokenToolNames(snapshotKey: string): Set<string> {
  const names: string = readJson(servedToolsPath)[snapshotKey].token.names;
  return new Set(names.split(" "));
}

/** A SKILL.md's YAML frontmatter as flat `key: value` pairs; the Agent Skills fields used here are single-line. */
function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  expect(match, "frontmatter opens and closes with ---").not.toBeNull();
  const fields: Record<string, string> = {};
  for (const line of match![1].split(/\r?\n/)) {
    const field = /^([a-z][a-z-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2];
  }
  return fields;
}

const skills = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ dir: entry.name, text: fs.readFileSync(path.join(skillsDir, entry.name, "SKILL.md"), "utf8") }));

// The Agent Skills format (agentskills.io), read by Agent Plugins 1.0 clients, ClawHub, skills.sh and Hermes.
describe("plugin skills", () => {
  it("has the letter-irl skill", () => {
    expect(skills.map((skill) => skill.dir)).toContain("letter-irl");
  });

  for (const skill of skills) {
    describe(skill.dir, () => {
      const fields = frontmatter(skill.text);

      it("names itself after its folder, within the format's limits", () => {
        expect(fields.name).toBe(skill.dir);
        expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(fields.name.length).toBeLessThanOrEqual(64);
      });

      it("has a description within the format's limit", () => {
        expect(fields.description.length).toBeGreaterThan(0);
        expect(fields.description.length).toBeLessThanOrEqual(1024);
      });

      it("connects to the server in mcp.json", () => {
        const url: string = readJson(path.join(pluginDir, "mcp.json")).mcpServers["letter-irl"].url;
        expect(skill.text).toContain(url);
      });

      it("names only tools a token client can be served", () => {
        const served = tokenToolNames("all on");
        const tools = [...skill.text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
        expect(tools.length).toBeGreaterThan(0);
        expect(tools.filter((name) => !served.has(name))).toEqual([]);
      });

      // request_send comes with the send-confirmation page, which production serves: the skill's only send path.
      it("relies for the sending steps only on the base tools and the confirmation page", () => {
        const always = tokenToolNames("only LETTER_IRL_SEND_CONFIRMATION_ENABLED");
        for (const tool of ["quote_and_preview_letter", "quote_and_preview_postcard", "request_send", "get_order_status"]) {
          expect(always.has(tool), tool).toBe(true);
          expect(skill.text).toContain(`\`${tool}\``);
        }
      });

      it("never says the agent can send mail itself", () => {
        expect(skill.text).toMatch(/cannot send mail by yourself/);
        expect(skill.text).not.toMatch(/`send_letter`|`send_postcard`/);
      });
    });
  }
});
