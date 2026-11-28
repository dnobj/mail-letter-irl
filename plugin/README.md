# Letter IRL plugin package

The package uploaded to the OpenAI Plugin Directory (platform.openai.com → **Plugins** → **Upload
new or existing plugin**), as described in
[owner-checklist.md](../docs/app-submission/owner-checklist.md#plugin-portal-gates).

- `plugin.json`: the listing (`extensions.com.openai.interface`), the review details
  (`extensions.com.openai.review`: five positive and three negative test cases, the commerce
  declaration) and `publication` (United States, release notes).
- `mcp.json`: the production MCP server, `https://api.letterirl.com/mcp`, over streamable HTTP,
  signing in with OAuth and CIMD.
- `assets/`: the logo (`logo.png`, 512×512, the website's `icon-512.png`) and the composer icon
  (`composer-icon.svg`, the website's `icon-64.svg`).

Not in the package, by the portal's rules: the reviewer account's credentials and instructions
(the dashboard's **Review details** form), the demo recording URL (required for review, entered in
the dashboard if it is not added here), and any client secret.

`tests/unit/mcp/pluginPackage.test.ts` keeps the listing within the portal's limits, and checks
that every test case names only tools ChatGPT is served at the launch cut
(`tests/unit/mcp/__snapshots__/tools-list.chatgpt-launch.json`).

## The skill

`skills/letter-irl/SKILL.md` is an [Agent Skills](https://agentskills.io) skill: what Letter IRL
does, when a letter helps, how to connect, the preview-then-the-person-sends steps, prices and
pitfalls. It is written for the agent that reads it. Like the tool descriptions, it is factual: it
never tells an agent to prefer Letter IRL, to prepare mail nobody asked for, or that it can send.

One file serves several places:

- **Agent Plugins 1.0 clients** (Codex, Cursor, GitHub Copilot, VS Code, Kiro) read `skills/` next
  to `plugin.json` and `mcp.json`.
- **ClawHub** (OpenClaw) and **skills.sh** list it from this folder.
- **Hermes Agent's** skills hub searches ClawHub and skills.sh, so a listing there reaches Hermes.

`tests/unit/mcp/pluginSkill.test.ts` checks the frontmatter against the format's limits, that the
skill names the server in `mcp.json`, and that every tool it names is one a token client is served
(`tests/unit/mcp/__snapshots__/servedTools.json`). Its prices are a dated snapshot: update them
when `src/config/products.ts` changes, and keep the pointer to `/capabilities.json`.

**The ChatGPT package does not carry the skill yet.** Uploading a ZIP with `skills/` changes the
approved listing's package, so it goes through OpenAI's review (see the post-approval rules in
`docs/app-submission/changing-the-api-after-approval.md`, on its own docs PR until that merges).
The ZIP command below leaves `skills/` out.

### Publishing the skill (the owner)

After this folder is on `master`:

1. **ClawHub.** Before publishing, OpenClaw needs a production sign-in: its client document is not
   imported into the production Auth0 tenant, which has no free application slot
   ([auth0-tenant-configuration.md](../docs/auth0-tenant-configuration.md), section 7). Free a slot,
   import `https://letterirl.com/oauth/openclaw-client-metadata.json`, and run CLIENT-06 against
   production. Then, signed in to ClawHub as Letter IRL's publisher:
   `clawhub skill publish ./plugin/skills/letter-irl --slug letter-irl --name "Letter IRL" --version 1.0.0`.
   (`clawhub publish` is the older alias; `--dry-run` checks it without uploading.) **Publishing
   releases the skill under MIT-0**, ClawHub's licence for every skill: anyone may copy it. Keep the
   publisher's handle verified; ClawHub had malicious skills in February 2026, and
   people check who published.
2. **skills.sh.** No submission: it lists a public repository's skill once someone installs it.
   Run `npx skills add dnobj/mail-letter-irl` once and check that it finds `letter-irl`.
3. **Hermes.** Check that `/skills search letter` in Hermes finds it after steps 1 and 2. Hermes
   signs in with its own client document, imported on both Auth0 tenants.

## Building the ZIP

The files must sit at the root of the ZIP, not inside a `plugin/` folder, with forward slashes in
the entry names (`assets/logo.png`). In PowerShell, from the repository root, with Windows' own
`tar` (Git Bash's `tar` is GNU tar, which does not write ZIPs):

```powershell
C:\Windows\System32\tar.exe -a -c -f letter-irl-plugin.zip -C plugin plugin.json mcp.json assets
```

Windows PowerShell 5.1's `Compress-Archive` writes `assets\logo.png`, with a backslash, which a
validator looking for `./assets/logo.png` may not find; do not use it. Check the entries with
`tar.exe -t -f letter-irl-plugin.zip`.

The README stays out of the ZIP. Keep `letter-irl-plugin.zip` out of Git.
