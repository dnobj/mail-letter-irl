# Layout Options Research

**Date:** December 20, 2025
**Status:** Research Complete

## Overview

Research findings for implementing multiple letter layout options in Letter IRL, including pricing from PostGrid, OpenAI Apps SDK image support, and phased implementation approach.

---

## PostGrid Pricing (December 2025)

Source: [PostGrid Print & Mail Pricing](https://www.postgrid.com/pricing-print-mail/)

### Base Products (USA, First Class)

| Product | PostGrid Cost |
|---------|---------------|
| B&W Letter (1 page) | $1.02 |
| Color Letter (1 page) | $1.18 |
| 4x6 Postcard | $0.86 |
| 6x9 Postcard | $0.98 |
| 6x11 Postcard | $1.25 |

### Add-Ons

| Add-On | Cost |
|--------|------|
| Additional B&W Page | +$0.10 |
| Additional Color Page | +$0.20 |
| Express Delivery (1-3 days) | +$15.00 |
| Certified Mail | +$6.69 |
| Certified + Return Receipt | +$9.51 |

---

## PostGrid API Capabilities

### Letters API (`/letters`)

Parameters:
- `color: boolean` - Enable color printing
- `doubleSided: boolean` - Print on both sides
- `express: boolean` - Express delivery (cannot combine with extraService)
- `extraService: string` - 'certified' or 'certified_return_receipt'
- `addressPlacement: 'top_first_page' | 'insert_blank_page'`

Multi-page support:
- Use CSS `page-break-before: always` in HTML
- Or submit multi-page PDF directly

### Postcards API (`/postcards`)

Separate endpoint from letters with different parameters:
- `frontHTML` or `frontPDF` - Front side content
- `backHTML` or `backPDF` - Back side content
- `size: '6x4' | '6x9' | '6x11'`

Sources:
- [Sending Letters](https://postgrid.readme.io/docs/sending-letters-using-the-api)
- [Sending Postcards](https://postgrid.readme.io/docs/sending-postcards-using-the-api)
- [Mailing Options](https://postgrid.readme.io/docs/mailing-options-from-first-class-to-express-shipping)

---

## OpenAI Apps SDK Image Support

As of December 2025, the OpenAI Apps SDK supports file/image uploads to MCP tools.

### How It Works

1. **Tool declares file parameters:**
```typescript
_meta: {
  "openai/fileParams": ["image"]
}
```

2. **Tool receives file object:**
```typescript
{
  download_url: "https://...",
  file_id: "file_..."
}
```

3. **Supported formats:** PNG, JPEG, WebP

### Widget Runtime APIs

- `window.openai.uploadFile(file)` - Upload from widget
- `window.openai.getFileDownloadUrl({ fileId })` - Get temporary URL

Sources:
- [Build your MCP server](https://developers.openai.com/apps-sdk/build/mcp-server/)
- [Apps SDK Reference](https://developers.openai.com/apps-sdk/reference/)

---

## Planned Layout Options

| Layout | Format | Image | Credits | PostGrid |
|--------|--------|-------|---------|----------|
| **B&W Letter** | 8.5x11" | No | 2 | `/letters` |
| **Color + Photo** | 8.5x11" 2-page | Photo on page 2 | 3 | `/letters` + `color:true` |
| **Postcard** | 6x4" | Front photo | 2 | `/postcards` |

### Color Letter with Photo

- Letter text on page 1
- User-uploaded photo on page 2
- Use CSS `page-break-before: always` to force page break
- PostGrid `color: true` for color printing

### Postcard

- Front: Full-bleed user photo
- Back: Message text + address area
- ~400 character limit (much smaller than letter)
- Requires image upload

---

## Future Delivery Add-Ons (Not in Initial Scope)

| Add-On | PostGrid Cost | Potential Credits |
|--------|---------------|-------------------|
| Express (1-3 day) | +$15.00 | +30 |
| Certified Mail | +$6.69 | +14 |
| Certified + Receipt | +$9.51 | +20 |

Note: Express cannot be combined with Certified Mail options.

---

## Implementation Phases

### Phase 1: Foundation
- Database migration for `layout_type` enum
- Type definitions (`LetterLayoutType`)
- Pricing constants file
- Preview service refactor for multiple layouts

### Phase 2: Image Handling
- New `imageService.ts` for download/validation
- Tool schema updates for image parameter
- `openai/fileParams` metadata

### Phase 3: Color Letter with Photo
- Layout validation (image required)
- 2-page HTML generation with page break
- Widget preview with image display

### Phase 4: Postcard Support
- `sendPostcard()` method in PostGridProvider
- Front/back HTML generation
- Character limit validation (~400 chars)

### Phase 5: Polish & Testing
- Unit tests for each layout
- Integration tests for PostGrid API
- Widget testing in ChatGPT

---

## Key Files to Modify

| File | Changes |
|------|---------|
| `db/migrations/012_letter_layouts.sql` | Schema changes |
| `src/services/providers/types.ts` | LetterLayoutType, PostcardParams |
| `src/constants/pricing.ts` | New: LAYOUT_CREDITS |
| `src/services/imageService.ts` | New: image download/validation |
| `src/services/previewService.ts` | Layout-specific renderers |
| `src/services/providers/PostGridProvider.ts` | sendPostcard(), generateHTML with image |
| `src/tools/quoteAndPreview.ts` | layoutType + image params |
| `src/tools/sendLetter.ts` | Route by layout type |
| `widgets/LetterPreviewCard.html` | Layout badge, image preview |

---

## Related Documentation

- [Widget Debugging Notes](./widget-debugging-notes.md) - How widgets receive data
- [Image Support Notes](../image-support.md) - Previous image research (now outdated)
