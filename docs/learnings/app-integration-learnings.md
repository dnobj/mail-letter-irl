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
- Google Identity Platform / Firebase Auth does **not** expose RFC 7591 dynamic client registration to external developers; you must create OAuth clients manually in the console, so ChatGPT’s connector flow can’t auto-register there. ([source](https://stackoverflow.com/questions/30385666/which-well-known-openid-providers-is-a-new-site-expected-to-support))
- We added a `/oauth/register` stub that returns a pre-provisioned client ID to unblock testing, but a production deployment should rely on an identity provider that supports RFC 7591 (e.g., Auth0/Okta CIC).
- If you want to stay on Google Cloud, the recommended best-of-breed approach is: Auth0 for identity (dynamic registration), Firestore/Cloud Run/etc. for data, with the MCP server validating Auth0-issued tokens.

## 2025-12-29 — Soft vs Hard Limits for Line Counts

When validating letter content, we use two tiers of limits:

**Soft Limits (Guidance)**: the line counts the manifest's prose names (`src/schemas.ts`, which feeds
`/manifest.json` only). The tool descriptions served in `tools/list` state no line counts; a model
learns a limit from the refusal sentence, which names it.
- `inline_image`: 12 lines
- `header_image`: 15 lines (17 until #534: with the sign-off, 15 fits both the renderer's 16 and the legacy 17)
- `text_only`: 24 lines

**Hard Limits (Validation)**: What we actually enforce during validation
- `inline_image`: 14 lines (+2 buffer)
- `header_image`: 17 lines (no buffer: a 17-line body with a sign-off is refused and retried)
- `text_only`: 26 lines (+2 buffer)

**A buffer never passes the page.** Until 2026-09-29 the image layouts allowed 15 and 19 lines. A
print check in PostGrid's test mode printed a second page for both (#77):
- at 19 lines the header layout put lines 18 and 19 on page 2, with 17 on page 1 under the
  2-inch image;
- the inline layout printed a blank second page at 15.

At the new limits, a header-image letter at 17 lines and an inline-image letter at 14 each printed
on one page (2026-09-30).

Past the page, a letter prints, and is billed, an extra sheet. Lines are counted on
`letterPrintText`, the text exactly as the provider prints it. The print used to keep a body's
trailing blank lines, which the count dropped. `tests/unit/services/pageLineLimits.test.ts` holds
each limit under what the check printed on one page.

**Why the buffer?**
Even when ChatGPT follows instructions perfectly, line counts can exceed soft limits due to:
1. **Sign-off formatting**: "With warm regards,\nDave" adds 2 lines, not 1
2. **Character wrapping**: 612 chars ÷ 65 chars/line = 9.4 → rounds to 10 lines
3. **The sign-off's own line**: it starts on the line after the body (a single `\n`, no blank line
   since 2026-01-03), so a body at the soft limit plus a sign-off is over it

**Example scenario** (the failure that introduced the buffer, 2025-12-29, recounted for today's join):
- User content: 647 chars, 0 newlines in body (following instructions!)
- Body: ~612 chars → 10 lines
- Sign-off with `\n` → 2 lines
- **Total: 12 lines**: at the inline soft limit of 12, and under the hard limit of 14. (With the
  blank separator line of the time, it was 13.)

**Implementation**:
- `LAYOUT_LINE_LIMITS_SOFT` - for documentation/reference
- `LAYOUT_LINE_LIMITS` - used in actual validation
- The manifest's prose mentions the soft limits; the served tool descriptions do not
- Validation uses hard limits to avoid unnecessary retries, never past what prints on one page

**Files**: `src/services/previewService.ts`

---

## 2026-09-30 — PostGrid Prints in Open Sans

Our print HTML names Times New Roman for letters, Georgia for postcards and the gift card, and
Courier New for the gift code. PostGrid prints all of them in **Open Sans**, Regular or Bold; its
PDFs embed no other font. The preview is serif, so the paper doesn't match it (#526).

Open Sans draws Latin (with Vietnamese), Greek, Cyrillic and Hebrew, and common symbols (€ £ ¥ © ®
™ — – “ ” ‘ ’ … •). Emoji, Chinese, Japanese, Korean, Arabic, Hindi and Thai print as empty boxes
(the font's `.notdef` glyph). The preview shows them, and nothing warns the sender.

For line counts, 12pt Open Sans across 6.5 inches holds 74 to 82 mixed-case characters a line, and
66 to 70 capitals. `CHARS_PER_LINE` (65) holds for both.

**Reading a printed letter:**
- On a PostGrid letter's page, expand **Raw Data** for `pageCount`, and for the PDF's link as `url`.
- Fetch the PDF from that page rather than copying the link out: the link is signed.
- Font names are the PDF's `/BaseFont` entries, stored uncompressed.
- A glyph id of 0 in the text is a `.notdef` box.
- Some PDFs come back rewritten by Ghostscript, whose text layer (ToUnicode) is wrong for dashes,
  quotes and some Greek and Hebrew letters. Check those glyphs by their widths in the font's `/W`
  array: an em dash is 1000, an en dash 500, a digit 572.

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
