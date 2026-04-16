# ChatGPT App Integration Learnings

This log captures short notes discovered while connecting Letter IRL to the ChatGPT Apps SDK in November 2025.

## 2025-11-07 — Tool Content Type Validation
- The MCP Inspector rejects tool responses whose `content` items have `type: "json"`; only the standard literal values (`text`, `image`, `audio`, `resource`, `resource_link`) are permitted.
- Resolution: emit a brief textual summary in `content` (e.g., `"Balance: 5 credits"`) and keep the detailed data plus metadata inside `structuredContent`. Widgets still render from `structuredContent`.
- Symptom in ChatGPT: tool call returned HTTP 200 but surfaced error code 424 with the message “issue retrieving your balance.” MCP Inspector showed `ZodError invalid_union` at `content[0].type`.

## 2025-11-07 — Initialization Flow
- ChatGPT sends two `initialize` requests with different `protocolVersion` values. Enabling `sessionIdGenerator` in the Streamable HTTP transport caused the second initialize to fail with “Server already initialized.”
- Resolution: remove the custom session ID generator so the transport remains stateless. `Mcp-Session-Id` headers are no longer required for subsequent requests.

## 2025-11-08 — OAuth Reality Check
- Google Identity Platform / Firebase Auth does **not** expose RFC 7591 dynamic client registration to external developers; you must create OAuth clients manually in the console, so ChatGPT’s connector flow can’t auto-register there.citestackoverflow.com/questions/30385666/which-well-known-openid-providers-is-a-new-site-expected-to-support
- We added a `/oauth/register` stub that returns a pre-provisioned client ID to unblock testing, but a production deployment should rely on an identity provider that supports RFC 7591 (e.g., Auth0/Okta CIC).
- If you want to stay on Google Cloud, the recommended best-of-breed approach is: Auth0 for identity (dynamic registration), Firestore/Cloud Run/etc. for data, with the MCP server validating Auth0-issued tokens.

## 2025-12-29 — Soft vs Hard Limits for Line Counts

When validating letter content, we use two tiers of limits:

**Soft Limits (Guidance)**: What we tell ChatGPT to aim for in tool descriptions
- `inline_image`: 12 lines
- `header_image`: 17 lines
- `text_only`: 24 lines

**Hard Limits (Validation)**: What we actually enforce during validation
- `inline_image`: 15 lines (+3 buffer)
- `header_image`: 19 lines (+2 buffer)
- `text_only`: 26 lines (+2 buffer)

**Why the buffer?**
Even when ChatGPT follows instructions perfectly, line counts can exceed soft limits due to:
1. **Sign-off formatting**: "With warm regards,\nDave" adds 2 lines, not 1
2. **Character wrapping**: 612 chars ÷ 65 chars/line = 9.4 → rounds to 10 lines
3. **Separator lines**: We add `\n\n` between body and sign-off (1 blank line)

**Example scenario** (actual failure before fix):
- User content: 647 chars, 0 newlines in body (following instructions!)
- Body: ~612 chars → 10 lines
- `\n\n` separator → 1 blank line
- Sign-off with `\n` → 2 lines
- **Total: 13 lines** (over soft limit of 12, but under hard limit of 15)

**Implementation**:
- `LAYOUT_LINE_LIMITS_SOFT` - for documentation/reference
- `LAYOUT_LINE_LIMITS` - used in actual validation
- Tool descriptions mention soft limits to guide ChatGPT
- Validation uses hard limits to avoid unnecessary retries

**Files**: `src/services/previewService.ts`

---

## 2025-12-28 — Tool Call Approval Dialog Button Text Derived from Description

ChatGPT generates the permission prompt text (the dialog asking the user to approve a tool call) based on the tool's `description` field. This means:

**Problem:**
- If your tool description says "Create a letter..." or "Send a message...", ChatGPT may show a permission prompt like "Send Letter?" even for read-only preview operations.
- This confused users who thought clicking "Allow" would send the letter, when it only generated a preview.

**Solution:**
- Start descriptions with action-accurate verbs: "PREVIEW a letter..." instead of "Create a letter..."
- Explicitly state side effects (or lack thereof): "This does NOT send anything."
- Clarify what the tool actually does: "Creates a DRAFT for the user to review."

**Example (before):**
```
"Create a letter WITH AN IMAGE enclosed after the signature."
```
Permission prompt showed: "Send Letter?" ❌

**Example (after):**
```
"PREVIEW a letter with an IMAGE enclosed after the signature. This does NOT send anything."
```
Permission prompt should show: "Create Preview?" ✓

**Key Insight:**
The `readOnlyHint: true` metadata tells ChatGPT the tool doesn't mutate state, but it doesn't affect the permission prompt text. The prompt text is derived from the description's natural language, so word choice matters.

**Related commits:**
- `019fc16` - Original fix for old unified tool
- `1d87ecd` - Fix for new three-tool split (text-only, header-image, inline-image)

---

Update this file whenever a new integration quirk is uncovered.
