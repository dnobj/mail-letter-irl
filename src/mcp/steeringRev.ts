/**
 * Revision counter for the image-routing guidance copy (issue #227).
 *
 * Bump this whenever the server instructions' image-routing guidance
 * changes. The value is logged with every tools/list response
 * (mcp.client_request), so a client whose cached metadata predates a copy
 * change is identifiable from logs instead of guesswork (the native mobile
 * apps cache tool metadata aggressively; see issue #235).
 *
 * r1: FALLBACK ONLY description on generate_image_fallback (PR #236)
 * r2: prohibition-first + image_gen named + chip-selection clause (PR #237)
 * r3: @-mention alone does not count as an explicit ask (PR #238)
 * r4: generate_image_fallback REMOVED - native generation is the only
 *     image-generation path; guidance now lives solely in server
 *     instructions. Decision record:
 *     docs/learnings/generate-image-removal-decision.md
 * r5: act-don't-explain directive - post-removal, a native-app @-mention
 *     ask sometimes produced "Letter IRL can't generate images" instead
 *     of falling through to image_gen; r5 scripts the fallthrough
 *     ("generate immediately... never pause to explain").
 * r6: generate_image_for_mail intent-trampoline tool added - matches
 *     @-mention generate requests and redirects to image_gen in-turn,
 *     replacing the first-turn capability narration.
 * r7: HYBRID - generate_image_for_mail generates in-turn with the user's
 *     Letter IRL image credits (starter/JIT/pack grants, global daily
 *     ceiling) and degrades to a copy-the-prompt redirect card otherwise.
 *     sendFollowUpMessage auto-nudge was dropped: on-device it resolved
 *     without ever posting the message (false positive).
 */
export const STEERING_COPY_REV = 7;
