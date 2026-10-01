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
 * r13: the image switch (LETTER_IRL_IMAGE_GEN_MODE=off) hides
 *     generate_image_for_mail from every app. ChatGPT is then told to use its
 *     own image generation, and the other apps that Letter IRL makes no images.
 * r14: Claude shows our cards (#474): its instructions name the preview card
 *     and its Create my preview button, its preview text points to the card's
 *     Send button, and get_started leaves the guide to the card.
 * r15: get_draft_status (#474), the preview card's card-only question about
 *     its draft. Its description reaches only a model in an app that shows
 *     card-only tools to it.
 * r16: photo upload through the card (#474, phase 3). While
 *     LETTER_IRL_CARD_UPLOAD_ENABLED is on, the card-only upload_photo_chunk
 *     is listed, and in an app whose card sends the photo itself (Claude) the
 *     instructions offer upload_image for an image not at a link, and they,
 *     upload_image's description and its result say to call the preview with
 *     no image once the card asks for it.
 * r17: upload_image's and confirm_uploaded_image's `context` parameter says
 *     what it takes ('postcard', 'header_image' or 'inline_image'). The
 *     served schema had no description, and in CLIENT-01 step 14 Claude
 *     filled it with a sentence, which upload_photo_chunk refused. The server
 *     now also reads a context in other words as one of the three, or none.
 * r18: launch text for the Plugin Directory. Under the send rule Pay & Send
 *     (create_mail_checkout) is card-only in every app (#475): Codex reaches
 *     us through ChatGPT's connection with no card, so no model may start a
 *     checkout that sends. ChatGPT's preview text names the card's Pay & Send
 *     when the card offers it,
 *     its instructions no longer ask the model to repeat a checkout, and the
 *     pack checkout's description points to the card. The image text no
 *     longer says "Never refuse an image request" or that purchases include
 *     image generations (#476).
 * r19: the preview tools' descriptions no longer end "Send later with
 *     send_letter" (or send_postcard) under the send rule (#516). Claude Code's
 *     model sees neither tool, and it reads the descriptions but not the
 *     preview's text. They now name the card's Send where the app shows our
 *     card, and request_send's link elsewhere.
 * r20: send_letter's and send_postcard's descriptions under the send rule, in
 *     every app without honorsCardOnlyTools: VS Code, Hermes, Codex
 *     connecting directly, a token, an unknown app, and Claude Code, whose
 *     app hides the tools anyway. A call there answers with the confirmation
 *     link, so they say the call sends nothing and name request_send, where
 *     they said "Send a physical letter" (#516). ChatGPT and Claude keep them
 *     from the model, and their text is unchanged.
 * r21: arrival dates (#535). While LETTER_IRL_ARRIVE_BY_ENABLED is on, the
 *     four previews take arriveBy and set_arrival_date is listed, to set,
 *     move or clear a preview's date without previewing again.
 * r22: cancel_scheduled_mail (#535), listed with set_arrival_date: held mail
 *     cancelled free until it goes to the printer, with confirm: true.
 * r23: the four previews' output schema gains arrivalWindow (#535), the
 *     arrival dates on offer while the flag is on, for the cards' picker;
 *     set_arrival_date and cancel_scheduled_mail become callable by the cards.
 * r24: mail sent with an arrival date (#535) is "scheduled" on send_letter,
 *     send_postcard, get_order_status and list_orders, with its dates and
 *     whether it can be cancelled, and the send and status narration say when
 *     it goes to the printer and that cancel_scheduled_mail can cancel it.
 * r25: get_draft_status (card-only, #535) answers a ready draft's
 *     deliveryEstimate, and for a sent one where its order stands, from the
 *     letter itself: orderStatus and cancellable.
 * r26: request_send (#535) carries a preview's arrival dates (schedule), and
 *     its link text says when, once sent, the mail goes to the printer.
 * r27: cancel_scheduled_mail's description promises only what is sure: what
 *     paid for the mail goes back while it can still be used, and the answer
 *     says what came back (#535).
 * r28: the same sentence names both exceptions: what paid goes back unless it
 *     expired or was refunded while the mail waited (#562 review round 2).
 * r29: stationery (#563). While LETTER_IRL_STATIONERY_ENABLED is on and our
 *     renderer draws the previews, the three letter previews take
 *     stationery, monogram and headline, and their output says which
 *     stationery the page was drawn in.
 */
export const STEERING_COPY_REV = 29;
