# Letter IRL beyond ChatGPT: MCP clients plan

**Status:** decided on 2026-09-25, when the owner accepted the recommendations below. M1 is in progress.
**Tracks:** #145.
**Research:** three passes on 2026-09-25, recorded on #145 and summarised below.

## In short

- **One server serves every app.** ChatGPT, Claude, Codex, Claude Code and the rest all use the same address, `https://api.letterirl.com/mcp`, the same tools and the same cards. Each app adds only three things: an Auth0 registration so it can sign in, one install line on the website, and a live test.
- **Claude Desktop is covered by one Claude connector.** The same connector reaches Claude on the web, on phones, in Cowork, and in Claude Code for anyone signed in with a Claude account.
- **ChatGPT desktop is the same ChatGPT app,** now called a plugin. The exception is its Codex tab, which signs in by itself and needs its own registration.
- **A Neon-style "Connect your agent" card** needs no npm package and no backend of its own. It is a copyable prompt that tells a coding agent to add our server with its own built-in command.
- **Safety first.** Before this plan, nothing stopped an AI from sending a letter the person never saw. Now a letter goes out only when the person presses Send, either on our card or on a letterirl.com page.

## What the research settled

### Claude: Desktop, web, mobile, Cowork, Claude Code

| | |
|---|---|
| **Add** | Customize → Connectors → Add custom connector. Every plan can do this; Free allows one custom connector. Once added, it syncs to Desktop (Mac and Windows), the web, iOS, Android and Cowork. Claude Code picks up account connectors when it is signed in with a Claude account. |
| **Sign-in** | Runs from Anthropic's cloud, with the callback `https://claude.ai/api/mcp/auth_callback`. Claude uses its hosted client document, `https://claude.ai/oauth/mcp-oauth-client-metadata`. That document is live but undocumented, and until it is imported into Auth0, sign-in fails. |
| **Cards** | Claude renders MCP Apps cards on every surface, but not ours as built. Ours depend on ChatGPT's `window.openai`, and our `ui.domain` is the API origin, which Claude rejects. |
| **Buying** | "Purchases through third-party interactive connectors are not supported" (Claude Help Center, 2026-08-11). |
| **Approvals** | Set per tool: Always allow, Needs approval or Blocked. |
| **Install shortcut** | A prefilled link: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Letter%20IRL&connectorUrl=https%3A%2F%2Fapi.letterirl.com%2Fmcp`. Later, the Anthropic Connectors Directory. |
| **Not for us** | Desktop Extensions (`.mcpb`) and `claude_desktop_config.json` are for local servers. The old `mcp-remote` route is obsolete. |

### ChatGPT desktop: the new app with Chat, Work and Codex

- **One app now.** On 2026-07-09 the Codex app merged into the ChatGPT desktop app, on Mac and Windows. ChatGPT "apps" became **plugins**, and the Plugin Directory replaced the App Directory (#476).
- **Chat and Work** use the account's plugins. A published plugin, or a developer-mode connector added on the web, is the same app we already run. Whether the desktop app renders our cards is undocumented, so it needs a live test.
- **Codex** keeps its own server list: Settings → MCP servers, or `codex mcp add letter-irl --url https://api.letterirl.com/mcp`.
  - It signs in on the person's machine through a loopback address, with the client document `https://chatgpt.com/oauth/codex/IJMOsCBL6i7U/client.json`.
  - It asks before destructive calls unless the person switches that off.

### Neon's "Onboard your agent"

- **What the copied command does.** It installs Neon **skills**, the `SKILL.md` instruction files, into whichever coding agents it finds, using Vercel's open-source `skills` tool.
- **What it does not do.** It doesn't sign in and doesn't set up Neon's MCP server; `neon mcp` does that. Neon avoids registering each app by running its own authorization server, which lets any app register itself.
- **Where it works.** Only agents that can run commands can act on it. Chat apps get links instead.
- **Others do the same.** The pattern is common: Supabase's "Copy prompt", Stripe's `stripe agent setup`, Sentry and Cloudflare.

### Other apps

| App | Sign-in | Our cards | Notes |
|---|---|---|---|
| Gemini, only inside Gemini Spark (US, AI Pro or Ultra) | A pre-registered Auth0 client. Google's callback is captured in a test | No | Needs a Google AI Pro test account |
| Perplexity (Pro and up) | A client-id field, or API-key mode with a personal token | No | Needs a Pro test account |
| Hermes Agent | Its client document, imported into Auth0. Loopback ports 27890 to 27894 | No | `hermes mcp add letter-irl --url https://api.letterirl.com/mcp --auth oauth`. It calls tools without asking |
| OpenClaw | A client document we host, passed with `--oauth-client-metadata-url`; or a token header | No | Added with `openclaw mcp add`. ClawHub skills carried malware in February 2026 |
| VS Code | Its client document, imported into Auth0. Port 33418 | Yes, MCP Apps | Install link |
| Cursor, Gemini CLI, Windsurf, OpenCode | A published client id, because they have no client document | Varies | |
| Grok, consumer Copilot, Meta AI | None | None | Grok needs dynamic registration; Copilot and Meta AI can't connect at all today |

## The design

### 1. One server, one tool list, and a profile per app (#473)

- **Which app is calling.** The server reads it from the sign-in token's `azp`, which names the Auth0 application. Personal access tokens get the profile "token".
- **What a profile holds.** Whether the app renders our cards and honours card-only tools, whether purchases are allowed in it, and which card domain it needs.
- **Nothing else branches on the app.** Every app gets the same tool list, and an unknown app gets the safest profile.

### 2. Sending: only the person can finish it (#470, website #39)

There are two ways to send, and the AI can complete neither by itself:
- **The card's Send button.** In apps that render our cards, `send_letter` and `send_postcard` become card-only: `_meta.ui.visibility: ["app"]` and `openai/visibility: "private"`.
- **A confirmation link.** A new tool, `request_send`, returns `https://letterirl.com/confirm/<id>`. There the person, signed in, sees the same preview and cost, and presses Send, or Pay & Send if they have no letters left.

**Enforced on the server.** If an app whose profile doesn't honour card-only tools calls a send tool, the server creates a confirmation link instead of sending. That covers tokens, command-line agents and unknown apps.

**Also:**
- The send tools carry `anthropic/requiresUserInteraction: true`.
- The destructive hints stay.
- Personal access tokens become read-and-draft only.

**In ChatGPT,** a typed "send it" now gets the link, or a pointer to the card's button. This also sidesteps #411's lost Allow-once calls, because card presses always go through. The rule sits behind a switch, which is turned on only once the ChatGPT tests pass with it.

### 3. Sign-in (#469, #465, #466)

- **Stop advertising OIDC scopes** (`openid profile email`) in the 401 challenge and the resource metadata. Auth0 can't grant them to strict CIMD clients. Identity keeps coming from our Auth0 Action's claims. ChatGPT's DEV connector is tested first.
- **Import client documents** on dev, then production: Claude, Claude Code, Codex, VS Code and Hermes.
- **Host client documents** ourselves for OpenClaw and Kiro.
- **Create pre-registered clients** for Gemini, Perplexity, Cursor and Gemini CLI once their callbacks are captured.
- **Let `https://claude.ai` through the Origin check** if Claude sends it.
- **Clean up production Auth0.** It still advertises a registration endpoint although DCR is off.

### 4. Cards outside ChatGPT (#474, #475)

- **A bridge in each card.** It uses `window.openai` when present, and otherwise the MCP Apps protocol through `@modelcontextprotocol/ext-apps`.
- **The card domain** comes from the app's profile.
- **Fallbacks for ChatGPT-only features:**
  - photo upload goes to the upload-link page;
  - `widgetState` becomes data kept on the server.
- **Purchases in Claude.** The cards hide Pay & Send and Buy letters, and the text points to the Letter IRL dashboard.
- **Text results that stand alone.** For apps without cards they carry the draft id, the summary, the cost and how to send.

### 5. Getting people connected (website #38, website #40, #468, #476, #467)

- **Connect page.** One block per app, each shipped only after its live test passes.
- **"Connect your agent" card.** Agent icons and a Copy prompt button.
- **An optional skill.** A `SKILL.md` served from letterirl.com.
- **Listings:**
  - the ChatGPT Plugin Directory;
  - the MCP Registry;
  - the Anthropic Connectors Directory, after launch.

## Work plan

The order is safety, sign-in, cards, getting people connected, more apps, then production. Every step lands on dev first.

| Milestone | Changes | Issues |
|---|---|---|
| **M1: app profiles and send safety** | API-1 app profiles and logging. API-2 send confirmations, `request_send`, card-only send tools enforced on the server, host-neutral wording, and a switch. API-3 scoped personal access tokens. Web-1 the `/confirm/[id]` page | #473, #470, website #39 |
| **M2: sign-in for each app** | API-4 drops the OIDC scopes; the ChatGPT DEV link must pass before merging. Dev-tenant imports: Claude, Claude Code, Codex, VS Code, Hermes. The Origin allowlist | #469, #465 |
| **M3: cards outside ChatGPT** | API-5 the bridge in all six cards, the card domain per profile, the upload and purchase fallbacks | #474, #475 |
| **M4: getting people connected** | Web-2 the Connect page and the agent card. Web-3 the skill files (optional). API-6 `server.json` | website #38, website #40, #468 |
| **M5: more apps** | Gemini and Perplexity, after test accounts. OpenClaw's hosted client document. Published client ids | #466 |
| **M6: production** | The same Auth0 setup on production. Promote. Refresh the ChatGPT connector. A production pass per launch app. Listings | #476, #468 |

**Tests for M1:**
- unit and PostgreSQL integration tests for confirmations: replay, expiry, the wrong user, an erased account, no letters left;
- the ChatGPT DEV regression pass with the switch on: PREVIEW-01, PAY-01 to PAY-05, and the #411, #412 and #414 checks.

## Launch gate (#471)

An app appears on the Connect page only after it passes these steps on dev, and again on production:
1. install from the page;
2. sign in;
3. preview a letter;
4. the person sends it, from the card or through the link;
5. the refusals: no letters, an unconfirmed address, an erased account;
6. disconnect.

Each app gets one CLIENT-xx test in [manual-tests.md](manual-tests.md), with the app's version and the date.

## Decisions (2026-09-25)

1. **Sending:** only the card's Send button or a confirmation link. A typed "send it" in ChatGPT gets the link.
2. **Personal access tokens:** read and draft only at launch.
3. **Claude:** no purchase buttons, and a pointer to the dashboard instead.
4. **Launch set:**
   - must: ChatGPT (all surfaces), Claude (all surfaces, plus Claude Code), Codex;
   - should: Hermes, OpenClaw, VS Code, Cursor;
   - nice: Gemini and Perplexity, which each need a test account.
5. **Onboarding:** a copyable prompt with no npm package. The skill is optional.

## Only a live test can tell

- Whether Auth0 imports Claude's client document, and whether it accepts loopback redirects on any port (Claude Code, Codex).
  - **Answered 2026-09-26: yes to both.**
  - Claude, Claude Code, Codex, VS Code and Hermes were imported into the development tenant.
  - A loopback callback registered without a port accepts any port.
  - Claude, Claude Code, VS Code and Codex connected, and the log names each one.
  - See [auth0-tenant-configuration.md](auth0-tenant-configuration.md), Applications, section 6.
- **New from the Codex connect:**
  - Codex's document is derived from our URL, so one import per tenant covers every Codex user.
  - Codex needs a `scopes` line in its config, or it requests Auth0's OpenID scopes instead of ours ([openai/codex#15643](https://github.com/openai/codex/issues/15643)). The Codex instructions on the Connect page (website #38) must include that line.
  - Codex also offers the person's ChatGPT plugins as `codex_apps`, and the server sees those calls as ChatGPT. Before production gets the send rule, check whether that route shows its model the send tools ChatGPT hides (CLIENT-04).
- Whether Claude signs in once the OIDC scopes are gone, and whether ChatGPT still links.
  - **Answered 2026-09-26: Claude signs in with them still advertised.** Auth0 drops OIDC scopes for these clients rather than refusing them.
  - So #469 is not needed for Claude (CLIENT-01).
- Whether our cards render in Claude after the bridge, and in ChatGPT desktop and Codex.
  - Not yet: Claude could not display the card before the bridge (#474).
- Gemini's and Perplexity's callback addresses.
- Whether ChatGPT honours card-only tools the way its docs say.
  - **Answered 2026-09-26: yes.** Told "Send it.", the model gave the link and never called `send_letter` (SEND-01).
  - Claude also lists the send tools as app-only.

**Auth0's free plan allows 10 applications per tenant.** Development reached the limit with the five imports above, after four unused applications were deleted. Production has the same cap. M6 therefore needs one of these:
- a paid plan;
- one shared client for the long-tail apps (Hermes, OpenClaw, Cursor), which would then share the generic profile.

## Issues

| Issue | What |
|---|---|
| #145 | The umbrella issue |
| #465 | CIMD imports |
| #466 | Published and pre-registered clients |
| #467 | Anthropic directory, after launch |
| #468 | MCP Registry |
| #469 | OIDC scopes |
| #470 | Send safety |
| #471 | Per-app tests |
| #473 | App profiles |
| #474 | Cards outside ChatGPT |
| #475 | Purchases per app |
| #476 | ChatGPT plugins |
| #477 | The 2026-07-28 MCP spec, after launch |
| website #38 | Connect page |
| website #39 | Confirmation page |
| website #40 | Agent card and skill |
