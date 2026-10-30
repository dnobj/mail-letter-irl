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
