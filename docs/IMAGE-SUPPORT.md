# Image Support Documentation

**Last Updated**: January 2, 2026

This document describes Letter IRL's image support capabilities for postcards and letters, including technical specifications, processing details, and implementation notes.

## Executive Summary

Letter IRL **fully supports** images in both postcards and letters:

- **Postcards**: Full-image front with custom message on back
- **Letters with Header Image**: Image at top of letter (letterhead style)
- **Letters with Inline Image**: Image after signature
- **Text-Only Letters**: No images (baseline option)

Images are accepted via:
1. **File attachments** in ChatGPT (OpenAI Apps SDK `fileParams`)
2. **Direct URLs** as fallback (publicly accessible image URLs)

All images are validated, resized to print specifications (300 DPI), optimized for quality, and embedded as base64 in HTML templates sent to PostGrid.

---

## Current Implementation

### 1. Postcard Images

**Tool**: `quote_and_preview_postcard`

**Image Specifications**:

| Property | Value |
|----------|-------|
| Max File Size | 10 MB |
| Min Resolution | 100×100 pixels |
| Recommended Resolution | 1872×1248 pixels (optimal for 6×9 at 300 DPI) |
| Supported Formats | PNG, JPEG, WebP |
| Output Dimensions | 2700×1800 pixels (9"×6" landscape at 300 DPI) |
| Output DPI | 300 |
| JPEG Quality | 85 |
| Resize Mode | `cover` with `center` position (crops to fill) |
| Supported Sizes | 6×9 only (currently) |

**Text Specifications**:
- Message limit: 500 characters
- Printed on back of postcard

**Processing Pipeline**:
1. Download image from URL or file attachment
2. Validate file size (≤10 MB)
3. Validate format (PNG, JPEG, or WebP)
4. Validate dimensions (≥100×100 pixels)
5. Resize to 2700×1800 using Sharp with `cover` fit (crops and fills)
6. Convert to JPEG at quality 85
7. Encode as base64 data URI
8. Embed in PostGrid HTML template

**Validation Errors**:
- File too large: "Image is too large. Please use an image under 10MB."
- Unsupported format: "Unsupported image format. Please use PNG, JPEG, or WebP."
- Too small: "Image is too small for print quality. Please use at least 100x100 pixels."

### 2. Letter Header Images

**Tool**: `quote_and_preview_letter_with_header_image`

**Image Specifications**:

| Property | Value |
|----------|-------|
| Max File Size | 5 MB |
| Min Resolution | 100×100 pixels |
| Supported Formats | PNG, JPEG, WebP |
| Output Dimensions | 1950×600 pixels (6.5"×2" at 300 DPI) |
| Output DPI | 300 |
| JPEG Quality | 85 |
| Resize Mode | `inside` (fits within bounds, no crop, allows upscale) |
| Placement | Top of letter (letterhead style) |

**Text Specifications**:
- Body text limit: 1100 characters OR 17 lines
- Sign-off required

**Processing Pipeline**:
1. Download image from URL or file attachment
2. Validate file size (≤5 MB)
3. Validate format (PNG, JPEG, or WebP)
4. Validate dimensions (≥100×100 pixels)
5. Resize to fit within 1950×600 using Sharp with `inside` fit (maintains aspect ratio)
6. Convert to JPEG at quality 85
7. Encode as base64 data URI
8. Embed at top of letter HTML template

**Validation Errors**:
- File too large: "Header image is too large. Please use an image under 5MB."
- Unsupported format: "Unsupported image format. Please use PNG, JPEG, or WebP."
- Too small: "Image is too small for print quality. Please use at least 100x100 pixels."

### 3. Letter Inline Images

**Tool**: `quote_and_preview_letter_with_image`

**Image Specifications**:

| Property | Value |
|----------|-------|
| Max File Size | 5 MB |
| Min Resolution | 100×100 pixels |
| Supported Formats | PNG, JPEG, WebP |
| Output Dimensions | 1950×900 pixels (6.5"×3" at 300 DPI) |
| Output DPI | 300 |
| JPEG Quality | 85 |
| Resize Mode | `inside` (fits within bounds, no crop, allows upscale) |
| Placement | After signature (inline in body) |

**Text Specifications**:
- Body text limit: 800 characters OR 12 lines
- Sign-off required

**Processing Pipeline**:
Same as header images, but with different output dimensions (1950×900) and placement after signature.

**Validation Errors**:
- File too large: "Inline image is too large. Please use an image under 5MB."
- Unsupported format: "Unsupported image format. Please use PNG, JPEG, or WebP."
- Too small: "Image is too small for print quality. Please use at least 100x100 pixels."

### 4. Text-Only Letters

**Tool**: `quote_and_preview_letter`

**Text Specifications**:
- Body text limit: 1600 characters OR 24 lines
- No images
- Baseline option for pure text letters

---

## Technical Implementation

### Image Service

**File**: `src/services/imageService.ts`

**Key Functions**:

1. **`downloadAndProcessImage(input, size)`** - Postcard image processing
   - Accepts OpenAI `fileParams` or URL object
   - Returns base64 data URI with metadata
   - Throws `ImageProcessingError` on validation failure

2. **`downloadAndProcessLetterImage(input, imageType)`** - Letter image processing
   - Accepts OpenAI `fileParams` or URL object
   - `imageType`: `'header'` or `'inline'`
   - Returns base64 data URI with metadata
   - Throws `ImageProcessingError` on validation failure

**Dependencies**:
- `sharp` - Image processing library for Node.js

### Schema Definitions

**File**: `src/schemas.ts`

**Letter Schemas**:
- `quoteAndPreviewLetterTextOnlyInputSchema` - No image parameters
- `quoteAndPreviewLetterWithHeaderImageInputSchema` - Header image parameters
- `quoteAndPreviewLetterWithImageInputSchema` - Inline image parameters

**Postcard Schema**:
- `quoteAndPreviewPostcardInputSchema` - Front image parameters

**Image Parameters** (all schemas with images):
```typescript
{
  // Primary method: file attachment
  image: {
    download_url: string,  // OpenAI-provided download URL
    file_id: string        // OpenAI file identifier
  },
  // Fallback method: direct URL
  imageUrl?: string
}
```

### Tool Implementations

**Files**:
- `src/tools/quoteAndPreviewLetterTextOnly.ts`
- `src/tools/quoteAndPreviewLetterWithHeaderImage.ts`
- `src/tools/quoteAndPreviewLetterWithImage.ts`
- `src/tools/quoteAndPreviewPostcard.ts`

Each tool:
1. Validates input (address, text length, image if provided)
2. Processes image if present (download, validate, resize, encode)
3. Generates HTML preview
4. Creates draft record in database
5. Returns preview with base64 image (widget) or lean response (model)

**Performance Optimization** (PR #97):
- Widget displays full base64 preview
- Model receives lean response without base64 (reduces token usage)
- Split implemented via `_meta.openai/outputTemplate` vs. regular response

---

## Platform-Specific Notes

### OpenAI Apps SDK / ChatGPT

**File Attachments** (`fileParams`) — updated August 2026 (issue #227):
- The handoff of ChatGPT-generated images to Letter IRL tools **works directly** on desktop web, mobile web, and the native mobile app. Verified end-to-end 2026-08-20/21 with real drafts on every surface.
- This REQUIRED two things that landed in August 2026: the served file-param schemas conforming exactly to the Apps SDK contract (PRs #231–#233 — the earlier `z.any()`/union schemas silently disabled the transform), and a connector **Refresh** (not Reconnect) so ChatGPT re-ingests the schemas.
- Mechanism note: the model passes a `/mnt/data/...` sandbox path string in its visible tool input; ChatGPT's platform transform swaps in the real `{download_url, file_id}` object on the wire. A path string in the dev panel's Request display does NOT mean the handoff failed — judge by the tool response.

**Superseded guidance** (kept for history — accurate before the August 2026 schema fixes):
- ~~Generated images "cannot pass directly to MCP tools"; workaround was Code Interpreter resize/crop to mint a passable file reference.~~ No longer needed on any tested surface. The Code Interpreter resize still works and remains harmless if a model chooses it.
- Desktop timing (app selected before upload) and mobile flakiness remain worth watching; when a handoff DOES fail, the recovery path is `upload_image` — its widget's "Choose from Library" picker lists generated images and preserves the exact image the user approved (PR #234). `generate_image_fallback` is last-resort only (it generates a NEW image).

**References**:
- Issue #227 (full evidence trail: experiments, schema fixes, per-surface verification)
- [OpenAI Community Discussion - Mobile Issues](https://community.openai.com/t/apps-sdk-on-mobile-devices/1366422)
- [ChatGPT Images (GPT Image 1.5) Announcement](https://openai.com/index/new-chatgpt-images-is-here/) (December 16, 2025)

### Claude Desktop / MCP Clients

**Image Support**:
- Accepts file attachments via MCP protocol
- Base64 image responses work (1MB limit)
- URL-based images work as fallback

---

## PostGrid Integration

### HTML Template Method

PostGrid accepts HTML content with embedded images via:
1. **Base64 data URIs**: `<img src="data:image/jpeg;base64,..." />`
2. **External URLs**: `<img src="https://example.com/photo.jpg" />`
3. **Merge variables**: `<img src="{{imageUrl}}" />`

Letter IRL uses **base64 data URIs** for reliability and control.

### Print Specifications

**PostGrid Processing**:
- Converts HTML to PDF for printing
- Likely renders at 300 DPI (not explicitly documented)
- Handles CSS styling and layout

**Best Practices** (from PostGrid docs):
- "For optimal results with custom images, all replacements should have the same size"
- Inconsistent sizes may cause unpredictable visual behavior

**Letter Margins**:
- Standard US letter: 8.5"×11"
- Side margins: 1" each
- Content area: 6.5" wide (1950px at 300 DPI)

**Color vs B&W**:
- Color letters cost more than B&W
- Letter IRL uses color for all letters with images

---

## Known Limitations and Future Enhancements

### Current Limitations

1. **Postcard Size**: Only 6×9 supported (PostGrid supports 6×4 and 6×11 as well)
2. ~~**Image Processing**: Cannot accept AI-generated images directly~~ — RESOLVED August 2026: direct handoff works on all tested surfaces after the fileParams schema fixes (#231–#233) plus connector Refresh; see issue #227 and Platform-Specific Notes above
3. **Mobile File Attachments**: Historically unreliable on ChatGPT mobile; direct handoff verified working August 2026, with `upload_image`'s Library picker as the recovery path if it regresses
4. **Desktop Timing**: App must be selected before uploading images (local path issue)
5. **File Size**: 5-10 MB limits (reasonable for most use cases)

### GitHub Issue #67 (OpenAI Apps SDK)

**Status**: Superseded for Letter IRL, August 2026 — the scenarios below stopped reproducing once our served file-param schemas conformed to the Apps SDK contract (#231–#233) and the connector was Refreshed; see issue #227. Section kept as the historical record of the pre-fix behavior.

**Problem**: ChatGPT cannot pass certain image types to MCP tools

**Affected Scenarios**:

1. **AI-Generated Images** (ChatGPT Images / GPT Image 1.5, released December 16, 2025):
   - Relative paths: `/mnt/data/generated-image.png`
   - NOT the `chatgpt.com/backend-api/estuary/...` URLs visible in browser
   - Signed URLs created after tool execution, inaccessible to tools
   - **Workaround**: Have ChatGPT modify the image (resize, crop, etc.) via Code Interpreter - creates new file reference that CAN be passed

2. **Mobile File Attachments**:
   - File IDs: `file_0000000048e0620a99b5f4a30a7da9ec`
   - NOT full URLs or accessible content
   - **Workaround**: Preprocess with Code Interpreter for "print optimization" (US-POSTCARD-04)

3. **Desktop Timing Issues**:
   - Local paths: `/mnt/data/image-filename.jpg` if image uploaded before app selected
   - NOT `fileParams` with download URLs
   - **Workaround**: Select Letter IRL app first, then upload images

**OpenAI Response** (@katia-openai, Oct 23, 2025):
> "This is a known issue as there are **safety implications**. It's **on the roadmap** to find a way around this."

**ETA**: Not specified

**Fallback**: Users can always upload images to external hosting (Imgur, Dropbox, etc.) and provide URL via `imageUrl` parameter

**References**:
- GitHub Issue: https://github.com/openai/openai-apps-sdk-examples/issues/67
- ChatGPT Images (GPT Image 1.5): https://openai.com/index/new-chatgpt-images-is-here/
- TechCrunch Coverage: https://techcrunch.com/2025/12/16/openai-continues-on-its-code-red-warpath-with-new-image-generation-model/

**Model Timeline**:
- **DALL-E 3**: Previous external model (legacy)
- **GPT Image 1 (GPT-4o native)**: April 2025 - first native image generation
- **GPT Image 1.5 (ChatGPT Images)**: December 16, 2025 - current model (4x faster, better instruction-following, precise editing)

### Potential Future Enhancements

1. **Additional Postcard Sizes**: Support 6×4 and 6×11 PostGrid sizes
2. **ChatGPT Images Integration**: Direct integration when GitHub issue #67 is resolved (seamless AI-generated image support from GPT Image 1.5)
3. **Image URL Generation**: Built-in image hosting for user-uploaded files
4. **Advanced Styling**: Borders, fonts, letterhead templates (HTML/CSS only, no images)
5. **Color Options**: B&W letters for cost savings
6. **Multi-page Letters**: Support for longer letters with images

---

## Character Limit Reference

Quick reference for text limits per layout:

| Layout Type | Tool | Max Characters | Max Lines |
|-------------|------|----------------|-----------|
| Text-only letter | `quote_and_preview_letter` | 1600 | 24 |
| Header image letter | `quote_and_preview_letter_with_header_image` | 1100 | 17 |
| Inline image letter | `quote_and_preview_letter_with_image` | 800 | 12 |
| Postcard message | `quote_and_preview_postcard` | 500 | N/A |

**Important**: Text limits are enforced as **continuous paragraphs**. Users should NOT add blank lines between sentences - write as flowing text.

---

## Testing Image Support

### Test Cases

See `docs/user-stories.md` for complete acceptance criteria:
- **US-POSTCARD-01**: Preview a Postcard
- **US-POSTCARD-02**: Send a Postcard
- **US-POSTCARD-03**: Postcard Image Processing
- **US-POSTCARD-04**: Mobile Image Compatibility
- **US-LAYOUT-01**: Preview Letter with Header Image
- **US-LAYOUT-02**: Preview Letter with Inline Image
- **US-LAYOUT-04**: Letter Layout Image Processing

### Error Scenarios

| Scenario | Expected Behavior |
|----------|-------------------|
| No image provided (postcard) | Error: "No image provided. Please attach an image or provide imageUrl." |
| File too large (postcard) | Error: "Image is too large. Please use an image under 10MB." |
| File too large (letter) | Error: "[Header/Inline] image is too large. Please use an image under 5MB." |
| Unsupported format | Error: "Unsupported image format. Please use PNG, JPEG, or WebP." |
| Image too small | Error: "Image is too small for print quality. Please use at least 100x100 pixels." |
| Mobile file attachment fails | Suggest Code Interpreter preprocessing + URL fallback |
| Download fails | Error: "Couldn't download the image. Please try again." |

---

## References

### PostGrid Documentation
- **Letters API**: https://postgrid.readme.io/docs/sending-letters-using-the-api
- **Postcards API**: https://postgrid.readme.io/docs/sending-postcards-using-the-api
- **Images in Templates**: https://postgrid.readme.io/docs/customizable-images-and-backgrounds-in-templates
- **Design Guidelines**: https://postgrid.readme.io/docs/design-and-templates

### OpenAI / ChatGPT
- **GitHub Issue #67** (Image Passing): https://github.com/openai/openai-apps-sdk-examples/issues/67
- **Apps SDK Widgets**: https://developers.openai.com/apps-sdk/build/chatgpt-ui
- **MCP Server Guide**: https://developers.openai.com/apps-sdk/build/mcp-server
- **Apps SDK Examples**: https://github.com/openai/openai-apps-sdk-examples
- **Mobile Issues Discussion**: https://community.openai.com/t/apps-sdk-on-mobile-devices/1366422

### Model Context Protocol (MCP)
- **Tools Specification**: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- **MCP Discussions**: https://github.com/orgs/modelcontextprotocol/discussions

### Internal Documentation
- `docs/user-stories.md` - Acceptance criteria for all image features
- `docs/status.md` - Current implementation status
- `docs/ui-widgets.md` - Widget rendering with images
- `src/services/imageService.ts` - Image processing implementation
- `src/schemas.ts` - Tool schemas with image parameters

---

## Changelog

**January 2, 2026** (Second Update)
- Corrected OpenAI image generation model information:
  - Updated "GPT-4o native image generation" → "ChatGPT Images (GPT Image 1.5)"
  - Added model timeline: DALL-E 3 → GPT Image 1 (April 2025) → GPT Image 1.5 (December 16, 2025)
  - Updated all references to current model (GPT Image 1.5)
  - Added TechCrunch reference and OpenAI announcement link for GPT Image 1.5
  - Noted key features: 4x faster, better instruction-following, precise editing
- Core issue and workaround remain unchanged

**January 2, 2026** (First Update)
- Updated terminology: "DALL-E" → "GPT-4o native image generation" (launched March 2025)
- Added desktop timing requirement: app must be selected before uploading images
- Added workaround for AI-generated images: modify via Code Interpreter to create accessible file reference
- Updated GitHub issue #67 section with three affected scenarios (AI-generated, mobile, desktop timing)
- Updated status date to January 2026

**January 1, 2026**
- **MAJOR UPDATE**: Rewrote document to reflect fully implemented image support
- Changed from "future enhancement" to "current implementation"
- Added comprehensive specifications for all three image types (postcard, header, inline)
- Added technical implementation details from `imageService.ts`
- Added character limit reference table
- Added mobile compatibility notes (US-POSTCARD-04)
- Preserved GitHub issue #67 reference material
- Preserved PostGrid integration notes
- Updated all sections to reflect production status

**November 21, 2025**
- Initial research and documentation
- Confirmed PostGrid supports images in letters and postcards
- Identified ChatGPT/MCP limitations (issue #67)
- Decision: Text-only for MVP, revisit when platform supports images
