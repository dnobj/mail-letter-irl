# Tool Annotation Decision: readOnlyHint and idempotentHint Correctness

**Last Updated:** December 31, 2025
**Purpose:** Document the decision to correct tool annotations for OpenAI Apps SDK compliance
**GitHub Issues:** #92 (readOnlyHint), #94 (idempotentHint)

## Summary

The quote and preview tools had two incorrect annotations:
1. `readOnlyHint: true` - Wrong because they create draft records in the database
2. `idempotentHint: true` - Wrong because each call creates a NEW draft

This document explains the correct annotation values for all 12 tools.

---

## The Problem

Our quote/preview tools were marked as read-only:

```typescript
// INCORRECT - what we had
meta: {
  readOnlyHint: true  // Wrong!
}
```

However, these tools **create draft records** in the database and **call external APIs** for address validation.

---

## MCP Specification Definitions

From the [MCP Tools Specification](https://modelcontextprotocol.io/legacy/concepts/tools):

| Annotation | Type | Default | Definition |
|------------|------|---------|------------|
| `readOnlyHint` | boolean | false | Indicates the tool does NOT modify its environment |
| `destructiveHint` | boolean | true | Indicates the tool may perform destructive updates |
| `idempotentHint` | boolean | false | Repeated calls with same args have no additional effect |
| `openWorldHint` | boolean | true | Tool interacts with external entities |

**Key insight:** `destructiveHint` and `idempotentHint` are only meaningful when `readOnlyHint` is false.

---

## OpenAI Apps SDK Requirements

From the [App Submission Guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines/):

> **readOnlyHint** should only be used when a tool "only retrieves or lists data, but does not change anything outside of ChatGPT"

> "Write or destructive tools (e.g., **creating**, updating, deleting, posting, sending) must be clearly marked using the `readOnlyHint` and `openWorldHint`."

> "Incorrect or missing action labels are a **common cause of rejection**."

---

## What Quote/Preview Tools Actually Do

| Action | Modifies Environment? | Notes |
|--------|----------------------|-------|
| Create draft in `letter_drafts` table | **YES** | Database INSERT operation |
| Call PostGrid API for validation | External call | Read-only from PostGrid's perspective |
| Process/resize images | Internal | Temporary processing |
| Store preview HTML in draft | **YES** | Part of draft creation |

Creating a database record **is** modifying the environment, regardless of whether:
- The record is temporary (24-hour expiration)
- No credits are charged
- No physical mail is sent

---

## Correct Annotations

### Quote/Preview Tools (all 4 variants)

```typescript
annotations: {
  readOnlyHint: false,    // Creates draft record in database
  destructiveHint: false, // Draft creation is non-destructive (can be recreated)
  openWorldHint: true,    // Calls PostGrid API for address validation
  idempotentHint: false   // Each call creates a NEW draft with new draftId
}
```

**Why idempotentHint: false?** Per MCP spec, idempotent means "repeated calls with same args have no additional effect." But quote/preview tools create a new draft record on each call, even with identical inputs. This IS an additional effect.

### Send Tools (send_letter, send_postcard)

```typescript
annotations: {
  readOnlyHint: false,    // Modifies credits, creates letter record
  destructiveHint: true,  // Mail cannot be recalled once printed (see the September 2026 addendum)
  openWorldHint: true,    // Sends physical mail via PostGrid/USPS
  idempotentHint: true    // Draft consumption makes retries safe
}
```

### Read-Only Tools (get_account_balance, list_orders, etc.)

```typescript
annotations: {
  readOnlyHint: true      // Only reads data, no modifications
}
```

### Destructive Tools (clear_return_address)

```typescript
annotations: {
  readOnlyHint: false,
  destructiveHint: true,  // Deletes saved address
  openWorldHint: false    // Local database only
}
```

---

## UX Implications

You might worry `readOnlyHint: false` will add friction ("Are you sure?" prompts), but:

1. ChatGPT uses the **combination** of annotations to decide on confirmation flows
2. `destructiveHint: false` signals it's safe (non-destructive)
3. `idempotentHint: true` signals retries are safe
4. Preview tools don't charge credits or send mail

The annotations help ChatGPT "categorize and present tools appropriately" without necessarily adding confirmation dialogs for every non-read-only tool.

---

## Tool Annotation Summary

| Tool | readOnly | destructive | openWorld | idempotent |
|------|----------|-------------|-----------|------------|
| `quote_and_preview_letter` | false | false | true | **false** |
| `quote_and_preview_letter_with_header_image` | false | false | true | **false** |
| `quote_and_preview_letter_with_image` | false | false | true | **false** |
| `quote_and_preview_postcard` | false | false | true | **false** |
| `send_letter` | false | **true** | true | true |
| `send_postcard` | false | **true** | true | true |
| `get_account_balance` | true | - | - | - |
| `list_orders` | true | - | - | - |
| `get_order_status` | true | - | - | - |
| `get_return_address` | true | - | - | - |
| `set_return_address` | false | **true** | true | true |
| `clear_return_address` | false | true | false | true |

**Note:** Quote/preview tools have `idempotentHint: false` because each call creates a new draft record (see #94). The bold destructive values changed in September 2026; see the addendum below.

---

## Addendum, September 16, 2026: irreversible outcomes are destructive

The December decision read `destructiveHint` as "deletes or overwrites user data" and marked the
send tools non-destructive because credits can be refunded. OpenAI's current app-review guidance is
broader: set the destructive annotation to `true` if the tool "can cause irreversible outcomes
(deleting, overwriting, sending messages or transactions you can't undo, revoking access, or
destructive admin actions), even in only select modes, through default parameters, or through
indirect side effects", and explain in the justification what is irreversible and which safeguards
apply (confirmation steps, dry runs, scoping). Since June 2026 ChatGPT users can also choose to let
non-destructive actions run without asking, so the annotation is what keeps the permission prompt on
a send.

Under that reading `buildAnnotations()` now marks six tools destructive:

| Tool | Why |
|------|-----|
| `send_letter`, `send_postcard` | Physical mail cannot be recalled once printed; the terms say so. |
| `set_return_address` | Overwrites the saved address in place. |
| `create_mail_checkout` | Starts a payment the customer cannot undo alone, and a successful payment authorises the mail itself. |
| `create_pack_checkout` | Starts a payment the customer cannot undo alone (refunds are discretionary). |
| `clear_return_address` | Deletes the saved address (unchanged). |

Still non-destructive, with the reasoning: `redeem_promo_code` spends a code but only adds letters
for the customer; `generate_image_for_mail` consumes one generation and produces an image;
`confirm_uploaded_image` overwrites only a pointer to the customer's latest upload;
`submit_feature_request` and `upload_image` create records. The quote and preview tools create
drafts that expire on their own.

The `confirm: true` requirement on the send tools and the transactional idempotency (a consumed
draft cannot be sent twice) remain the safeguards to describe in the justification. They are not a
reason to omit the annotation. `buildAnnotations()` is what fills the MCP `annotations` block ChatGPT
reads; the inline `meta` objects in the tool files (spread into `_meta` by `buildToolMeta()`) mirror
the same hints beside the OpenAI display keys, and `scripts/verify-tool-annotations.ts` checks that
the mirror agrees.

---

## References

- [OpenAI Apps SDK - Define Tools](https://developers.openai.com/apps-sdk/plan/tools/)
- [OpenAI Apps SDK - App Submission Guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines/)
- [OpenAI Apps SDK - Reference](https://developers.openai.com/apps-sdk/reference/)
- [MCP Tools Specification](https://modelcontextprotocol.io/legacy/concepts/tools)
- [Quick Fix: MCP Tools Showing as Write Tools](https://dev.to/nickytonline/quick-fix-my-mcp-tools-were-showing-as-write-tools-in-chatgpt-dev-mode-3id9)

---

## Related Documents

- `docs/learnings/openai-app-sdk-notes.md` - Apps SDK status and action items
- `docs/user-stories.md` - US-MCP-06: Tool Read/Write Annotations
- `docs/user-stories.md` - US-MCP-09: Tool Idempotency Annotations
