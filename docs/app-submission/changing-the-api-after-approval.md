# Changing the API After Approval

**Last Updated:** November 22, 2026
**Purpose:** What can change on production once Letter IRL is listed with OpenAI and Anthropic, and what has to go through review

Neither ChatGPT nor Claude holds a copy of our code. Both call the production API, so a change is never "implemented on their side". The question for each change is whether the host will show it straight away, hold it for a check, or need a review first.

The ChatGPT plugin was approved and published on 2026-11-22, so the rules below now apply to every production promotion. The Claude directory listing is still in review.

Letter IRL keeps one production API. Differences between apps go through `src/auth/clientProfiles.ts` and `src/mcp/toolCatalog.ts`, not through a second deployment.

## What each kind of change needs

| Change | ChatGPT | Claude |
|--------|---------|--------|
| Server code, with tools and cards unchanged | Deploy | Deploy |
| New tool | Deploy; it stays unavailable until approved | Deploy; it appears on the next connection. Add its name to the listing (reviewer approves) |
| Changed tool name, description or schema | Deploy; the daily scan or a Rescan checks it. Eligible updates go live after automated checks; a flagged one is held and the approved definition stays live | Deploy. A changed name also needs a listing edit |
| Removed tool | Takes effect after a scan | Deploy, and update the listing's tool names |
| Card fix that stays compatible, same URI | Can go live without a new version; ChatGPT may cache the old content for up to an hour (OpenAI support forum reply, 2026-09-29) | Not covered by the published pages |
| New card URI, or a breaking card change | New version and review; keep the approved URI working until it is published (OpenAI support forum reply, 2026-04-22) | Not covered by the published pages |
| Card CSP or domains | Goes through security review (OpenAI staff forum reply, 2026-04-28) | Not covered by the published pages |
| Listing text, icon, bundled skills | Upload a new package ZIP; it gets its own checks and review | Listing edit; a reviewer approves it. A display name change requires re-review |
| MCP server URL | Contact OpenAI support; the update flow does not support it | A moved endpoint no longer matches the directory entry. Do not move it |

Package and tool updates are separate paths at OpenAI. Hosted tool changes need no package upload.

Only one review can be active per plugin. Scans start after initial publication, so these rows describe life after approval. See "While a review is open" for the time before it.

## Rules

1. **Keep what is approved working.** OpenAI's rule is to keep the server compatible with the currently approved tool schemas until the updated metadata is live. A held update can leave the old definition live for a long time, so old inputs must keep working and old outputs must keep the fields that callers read.
2. **Add first, remove last.** New tools and new optional inputs ship freely. A tool that has to change shape gets a new tool beside it, and the old one goes only after the new one is live on ChatGPT.
3. **Cards stay compatible.** A card must work with the tool shapes in the approved definitions. Fixes ship. A redesign, or anything that changes what a card does or asks of the person, goes through review with a new version.
4. **No new card domains without a review.** The CSP in `src/mcp/registerTools.ts` is reviewed. Do not widen it as part of an ordinary change.
5. **Check after a tool change.** After promoting a tool change, the owner opens the plugin in the portal, selects MCPs, the server, then Issues, and uses Rescan. Issues shows "Issues found", "Held update" and "Live definition" for each tool.
6. **No hidden behaviour.** OpenAI's guidelines say tools must behave as their names, descriptions and inputs indicate. They also say previously approved plugins later found in violation may be removed, and that hidden behaviour may result in removal. Treat a change as if the reviewer can see it.

## What our code does today

`WIDGET_TEMPLATE_VERSION` in `src/mcp/widgetUris.ts` (100 on 2026-11-09) is part of every card URI, and `src/mcp/widgetUris.ts` says to bump it whenever card HTML changes. That habit was built for development and for the ChatGPT mobile apps' caching (#235). After approval it has two consequences:

- **A bump changes tool metadata.** The URI is in `openai/outputTemplate`, so a bump changes each tool that references a card, and the scan sees those changes. OpenAI staff have said URI cache-busting was never officially supported for published apps, and that it is meant for development mode.
- **Every old URI serves the current card.** `src/mcp/registerTools.ts` answers `ui://widgets/{name}.html@v{version}` with today's HTML. The approved URI keeps working, which is what OpenAI asks for. But it also means there is no way to keep an old card alive beside a new one. A breaking card change would reach ChatGPT users on the approved URI at once.

**Until OpenAI answers the questions below:** after approval, do not bump the version for a compatible card fix, and do not make a breaking card change. The cost is that ChatGPT may keep the old card for up to an hour, and possibly longer on the mobile apps.

## While a review is open

Hold production promotions that change what reviewers see. Anything still promoted during a review has to meet all of these:

- The ChatGPT and Claude tool lists are unchanged. `tests/unit/mcp/servedToolsSnapshot.test.ts` and its snapshots show that.
- Cards are unchanged.
- Database changes are additive only.
- Shared code is touched as little as possible.
- The cases in `openai-test-cases.md` are run on production afterwards.

A fix for something a reviewer could hit, and a security fix, go out regardless.

## What is not known

These are not answered by anything published as of the date above. Ask OpenAI support before relying on a guess:

- Whether the daily scan looks at card HTML, or only at tool definitions.
- Whether a changed `openai/outputTemplate` counts as an eligible update or is held.
- What counts as a "compatible" card change, and where a redesign falls.
- How long the mobile apps hold a card when its URI does not change.
- What Anthropic expects for changes to MCP Apps cards. Its pages cover tools and listings only.

The forum replies are from OpenAI staff, but they are not documentation, and some predate the plugin portal. OpenAI's staff have said different things about card resources over time (2026-06-03: resources are "of the app version"; 2026-09-29: compatible HTML can go live without one). The most recent reply is the one used here.

On Claude's side, a Verified label reflects the connector at the time of review, and Anthropic tells people that a connector's tools can change. Reliability shows on the listing's health badge, which reads Degraded when request errors are above 5%.

## Sources

- [OpenAI: Plugin submission and updates](https://developers.openai.com/apps-sdk/deploy/submission)
- [OpenAI: Plugin developer guidelines](https://developers.openai.com/apps-sdk/app-developer-guidelines)
- [OpenAI: Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI forum: MCP server URL and versioning during update submission](https://community.openai.com/t/clarification-on-mcp-server-url-and-versioning-during-chatgpt-app-update-submission/1379705)
- [OpenAI forum: Widget URI versioning and app resubmission](https://community.openai.com/t/widget-uri-versioning-and-app-resubmission/1374584)
- [OpenAI forum: Published ChatGPT apps no longer working](https://community.openai.com/t/published-chatgpt-apps-no-longer-working/1379989)
- [Anthropic: Manage your listing after publishing](https://claude.com/docs/connectors/building/after-publishing.md)
- [Anthropic: Manage your directory listing](https://claude.com/docs/connectors/building/managing-your-listing.md)
- [Anthropic: Connector verification](https://claude.com/docs/connectors/verification)
