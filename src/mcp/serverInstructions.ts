export const LETTER_IRL_SERVER_INSTRUCTIONS = [
  "Letter IRL drafts, previews, and sends real physical letters and postcards in the U.S.",
  "Always create a preview draft before sending. Preview tools are free drafts; they do not send mail.",
  "Only call send_letter or send_postcard after the user has reviewed a draft and clearly confirms sending.",
  "Do not say mail has been sent unless the send tool succeeds.",
  "Use saved return addresses when available, and ask for missing real U.S. mailing addresses when required.",
  "For image mail, reuse existing conversation images or generated imageUrl values before opening upload_image.",
  "Use generate_image as the Letter IRL fallback when this app is selected and native ChatGPT image generation is unavailable or blocked.",
  "For unsupported formats, integrations, or product ideas, offer submit_feature_request instead of promising support."
].join("\n");
