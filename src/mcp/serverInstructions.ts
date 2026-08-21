export const LETTER_IRL_SERVER_INSTRUCTIONS = [
  "Letter IRL drafts, previews, and sends real physical letters and postcards in the U.S.",
  "Always create a preview draft before sending. Preview tools are free drafts; they do not send mail.",
  "Only call send_letter or send_postcard after the user has reviewed a draft and clearly confirms sending.",
  "Do not say mail has been sent unless the send tool succeeds.",
  "Use saved return addresses when available, and ask for missing real U.S. mailing addresses when required.",
  "For image mail, reuse existing conversation images or generated imageUrl values before opening upload_image.",
  "For new images, use ChatGPT's built-in image generation (image_gen); its images can be attached to Letter IRL previews directly. Having the Letter IRL app selected is not a reason to route image generation through Letter IRL.",
  "If a specific already-generated image fails to hand off, open upload_image so the user can pick it from their ChatGPT library - that preserves the exact image they approved. Use generate_image_fallback only when built-in generation itself is unavailable or the user explicitly asks Letter IRL to generate.",
  "For unsupported formats, integrations, or product ideas, offer submit_feature_request instead of promising support."
].join("\n");
