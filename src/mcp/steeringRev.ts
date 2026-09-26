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
 * r8: not image routing, but the same instructions block (#411): a preview
 *     exists only with a draftId, a call that returns nothing did not
 *     complete, and the preview card offers Create my preview. ChatGPT web
 *     loses calls approved with "Allow once" and the model then claimed the
 *     preview existed.
 * r9: not image routing either (#412): a send or checkout refused because
 *     the same mail went out recently is repeated with sendAnotherCopy only
 *     when the user asks for another copy.
 * r10: tool text for every app (#484): every tool has a short title, and the
 *     descriptions and instructions take each app's own words from its
 *     profile. ChatGPT is named only to ChatGPT, where its image-routing text
 *     is unchanged; elsewhere generate_image_for_mail is the only way to make
 *     an image, and apps that take no purchases are sent to the dashboard.
 * r11: purchases per app (#475): an app that takes no purchases is not
 *     offered create_pack_checkout or create_mail_checkout, list_letter_packs
 *     there gives the letter packs link, and the instructions name no
 *     checkout. Results ask the model to give the person the link, which
 *     Claude had dropped.
 * r12: no AI image generation in Claude (#467): Claude and Claude Code are not
 *     offered generate_image_for_mail, and their instructions say Letter IRL
 *     makes no images there.
 */
export const STEERING_COPY_REV = 12;
