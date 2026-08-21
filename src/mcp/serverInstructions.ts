export const LETTER_IRL_SERVER_INSTRUCTIONS = [
  "Letter IRL drafts, previews, and sends real physical letters and postcards in the U.S.",
  "Always create a preview draft before sending. Preview tools are free drafts; they do not send mail.",
  "Only call send_letter or send_postcard after the user has reviewed a draft and clearly confirms sending.",
  "Do not say mail has been sent unless the send tool succeeds.",
  "Use saved return addresses when available, and ask for missing real U.S. mailing addresses when required.",
  "For image mail, reuse existing conversation images or hosted imageUrl values before opening upload_image.",
  "Letter IRL does not generate images. For any request to generate, create, draw, or make an image, use ChatGPT's built-in image generation (image_gen) - it is always available for image requests, including in Letter IRL conversations, and its images can be attached to Letter IRL previews directly.",
  "If a specific image fails to hand off to a preview tool, open upload_image so the user can pick it from their ChatGPT library or upload it - that preserves the exact image they approved.",
  "For unsupported formats, integrations, or product ideas, offer submit_feature_request instead of promising support."
].join("\n");
