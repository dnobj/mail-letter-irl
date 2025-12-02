# Image Support Research

**Last Updated**: November 21, 2025

This document summarizes research on image support for Letter IRL, including PostGrid capabilities, ChatGPT/MCP limitations, and future enhancement options.

## Executive Summary

- **PostGrid**: Supports images in letters (via HTML) and postcards
- **ChatGPT/MCP**: Currently **cannot** pass user-uploaded or AI-generated images to MCP tools (known issue #67)
- **Letter IRL Decision**: Focus on text-based letters initially; add image support when ChatGPT resolves platform limitations

---

## 1. PostGrid Image Capabilities

### Letters

**Image Support**: ✅ YES via HTML

PostGrid's letters API accepts HTML content that can include images:

```typescript
{
  html: `
    <!DOCTYPE html>
    <html>
    <body>
      <p>Dear Friend,</p>
      <img src="https://example.com/photo.jpg" alt="Photo" />
      <p>Hope you enjoy this photo!</p>
    </body>
    </html>
  `
}
```

**Methods for Including Images**:
- `<img>` tags with **URLs to hosted images**
- `<img>` tags with **base64 data URIs** (e.g., `data:image/jpeg;base64,/9j/4AAQ...`)
- **Merge variables** for dynamic images: `<img src="{{imageUrl}}" />`

**Image Processing**:
- ❌ PostGrid does **not** document automatic image processing/optimization
- ❌ No documented DPI conversion, resizing, or format conversion
- ✅ PostGrid converts HTML to PDF for printing (likely 300 DPI)
- ⚠️ **Recommendation**: Handle image processing client-side (resize, optimize, validate)

**Best Practices** (per PostGrid docs):
- "For optimal results with custom images, all replacements should have the same size"
- Inconsistent sizes may cause unpredictable visual behavior

### Postcards

**Support**: ✅ YES - Full support for images

**API Endpoint**: `POST /postcards`

**Content Methods**:
1. **HTML templates** with front and back designs
2. **PDF uploads** (local files or publicly accessible URLs)
3. **Template builder** with image placeholders

**Standard Size**: 6x4 inches (other sizes available)

**Image Capabilities**:
- Background images
- Picture placeholders
- Dynamic images via merge variables
- HTML/CSS layouts

**Key Parameters**:
```typescript
{
  frontTemplate: "template_id",
  backTemplate: "template_id",
  to: { /* address */ },
  from: { /* address */ },
  mergeVariables: {
    imageUrl: "https://example.com/photo.jpg"
  },
  size: "6x4"
}
```

---

## 2. ChatGPT / MCP Limitations (November 2025)

### User-Uploaded Images: ❌ NOT Supported

**Problem**: Users cannot upload images to ChatGPT and have them passed to MCP tools.

**What ChatGPT Sends**:
- File IDs: `file_0000000048e0620a99b5f4a30a7da9ec`
- Local paths: `/mnt/data/image-filename.jpg`
- **NOT** full URLs
- **NOT** base64 data
- **NOT** accessible file content

**Official Status** (GitHub Issue #67):
- **Opened**: October 19, 2025
- **Status**: OPEN
- **OpenAI Response** (@katia-openai, Oct 23, 2025):
  > "This is a known issue as there are **safety implications**. It's **on the roadmap** to find a way around this."
- **ETA**: Not specified

**GitHub Issue**: https://github.com/openai/openai-apps-sdk-examples/issues/67

### DALL-E Generated Images: ❌ NOT Supported

**Problem**: ChatGPT generates images with DALL-E, but cannot pass URLs to MCP tools.

**What ChatGPT Provides**:
- Relative paths: `/mnt/data/generated-image.png`
- **NOT** the `chatgpt.com/backend-api/estuary/...` URLs visible in browser
- Signed URLs are created after metadata response, inaccessible to tools

### MCP Protocol Limitations

**Tool Input Parameters**: Only JSON Schema types
- ✅ String, number, boolean, object, array
- ❌ **No binary data** or file objects
- ❌ **No image type**

**Workaround**: Accept image URLs as strings
```typescript
imageUrl: z.string().url().optional()
```

---

## 3. What Works Today

### ✅ External Image URLs as Parameters

MCP tools **can** accept publicly accessible image URLs:

```typescript
// Tool schema
const schema = z.object({
  bodyText: z.string(),
  imageUrl: z.string().url().optional()
});

// Tool handler
async function handler(input, context) {
  if (input.imageUrl) {
    // Fetch image from URL
    const response = await fetch(input.imageUrl);
    const imageBuffer = await response.arrayBuffer();

    // Process image (resize, optimize, etc.)
    const processedImage = await processImage(imageBuffer);

    // Embed in HTML
    const html = generateLetterHTML(input.bodyText, processedImage);
  }
}
```

**User Experience**:
- User must host image externally (Imgur, Dropbox, Google Drive, etc.)
- User provides URL in conversation
- Tool fetches and processes image

### ✅ MCP Tools Can Return Image URLs

Tools can return image URLs for display in ChatGPT:

**Method 1: Text with URL**
```typescript
return {
  content: [{
    type: "text",
    text: `Letter preview: https://example.com/preview.jpg`
  }]
};
```

**Method 2: Widget Display**
```typescript
return {
  structuredContent: {
    previewUrl: "https://example.com/preview.jpg",
    requiredCredits: 5
  },
  _meta: {
    "openai/outputTemplate": "ui://widget/letter-preview.html"
  }
};
```

Widget HTML:
```html
<script>
  const data = window.openai.toolOutput;
  document.getElementById('preview').src = data.previewUrl;
</script>
<img id="preview" alt="Letter Preview" />
```

**Method 3: Base64 Image (MCP Standard)**
```typescript
return {
  content: [{
    type: "image",
    data: "base64-encoded-image-data",
    mimeType: "image/jpeg"
  }]
};
```

**Limitations**:
- 1MB size limit (Claude Desktop)
- Mixed results with ChatGPT interpretation
- Base64 encoding increases payload size by ~33%

---

## 4. Current Letter IRL Decision

### Text-Only Letters (Phase 1)

**Rationale**:
1. **Known blocker**: GitHub issue #67 open with no ETA
2. **Scope creep**: Adding image generation would require additional APIs, storage, moderation
3. **Core value**: Text-based letters are already valuable and complete
4. **Clean upgrade**: Easy to add images when platform supports it

**Current Implementation**:
- Simple HTML template with text-only content (src/services/providers/PostGridProvider.ts)
- Address validation with PostGrid
- Credit-based pricing
- Order tracking
- Job queue for reliability

### When to Revisit

**Monitor these signals**:
1. GitHub issue #67 gets resolved or updated
2. Apps SDK adds file upload support in release notes
3. Community finds reliable workarounds
4. User feedback specifically requests image support
5. Competitor apps successfully implement it

---

## 5. Future Enhancement Options

### Option A: User-Provided Image URLs

**When**: After ChatGPT supports image passing, OR as immediate workaround

**Implementation**:
```typescript
// Add to tool schema
imageUrl: z.string().url().optional()

// Tool description update
"Optionally provide a publicly accessible image URL to include in the letter"
```

**Image Processing** (using Sharp):
```typescript
import sharp from 'sharp';

async function processImageForLetter(
  imageBuffer: Buffer,
  maxWidth: number = 600,
  maxHeight: number = 400
): Promise<string> {
  const processed = await sharp(imageBuffer)
    .resize(maxWidth, maxHeight, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  return `data:image/jpeg;base64,${processed.toString('base64')}`;
}
```

**Pros**:
- Works with current MCP limitations
- User has full control over image
- No additional API costs

**Cons**:
- User must host image externally
- Extra step in workflow

### Option B: PostGrid Postcard Integration

**What**: New tool for sending postcards with images

**Implementation**:
- New endpoint: `POST /postcards`
- Front and back templates
- Image URL parameters
- Different pricing structure

**Value Add**:
- Visual impact (postcards are image-forward)
- Lower cost than letters
- Different use cases (vacation photos, announcements, etc.)

**Complexity**: Medium
- New tool and schemas
- Template management
- Updated pricing/credits

### Option C: Letter Preview Images via Widgets

**What**: Display letter preview inline in ChatGPT

**Implementation**:
1. Generate preview image of letter (HTML → PDF → PNG)
2. Return preview URL in tool response
3. Widget displays preview inline

**Files**:
- `ui/letter-preview.html` - Widget HTML
- Update tool response to include preview URL

**Pros**:
- Great UX (see before sending)
- Builds confidence
- "Wow factor"

**Cons**:
- Requires preview generation infrastructure
- Additional API calls to PostGrid or rendering service
- Widget complexity

### Option D: HTML/CSS Styling Enhancements

**What**: Fancy text styling without images

**Options**:
- Borders and decorative CSS
- Different fonts (handwriting, serif, sans-serif)
- Letterhead templates
- Holiday themes
- Color options

**Implementation**: Pure HTML/CSS in template
```html
<style>
  body {
    font-family: 'Brush Script MT', cursive;
    border: 3px double #333;
    padding: 2em;
  }
</style>
```

**Pros**:
- No platform limitations
- No image processing needed
- Works today
- Low complexity

**Cons**:
- Limited visual impact vs. photos
- Constrained by print capabilities

---

## 6. Technical Implementation Notes

### If/When Adding Image Support

**Required Dependencies**:
```bash
npm install sharp  # Image processing
```

**Image Processing Pipeline**:
1. **Validation**: Check file type, size, dimensions
2. **Resize**: Constrain to printable dimensions (e.g., 600x400px)
3. **Optimize**: Compress to reduce payload size
4. **Format**: Convert to JPEG/PNG
5. **Embed**: Base64 encode or host on CDN

**Considerations**:
- Print resolution: 300 DPI ideal, 150 DPI minimum
- Letter margins: Account for 1" margins on 8.5x11" paper
- Color vs B&W: Color costs more ($1.20 vs $0.85)
- File size: Keep under 1MB for MCP responses
- Security: Validate image content, strip EXIF data

### Credit Pricing Updates

If adding images, update credit calculations:
- Color letter: Higher cost than B&W
- Image processing fee (if applicable)
- Storage costs (if hosting previews)

---

## 7. References

### PostGrid Documentation
- **Letters API**: https://postgrid.readme.io/docs/sending-letters-using-the-api
- **Postcards API**: https://postgrid.readme.io/docs/sending-postcards-using-the-api
- **Images in Templates**: https://postgrid.readme.io/docs/customizable-images-and-backgrounds-in-templates
- **Design Guidelines**: https://postgrid.readme.io/docs/design-and-templates

### ChatGPT / OpenAI
- **GitHub Issue #67**: https://github.com/openai/openai-apps-sdk-examples/issues/67
- **Apps SDK Widgets**: https://developers.openai.com/apps-sdk/build/chatgpt-ui
- **MCP Server Guide**: https://developers.openai.com/apps-sdk/build/mcp-server
- **Apps SDK Examples**: https://github.com/openai/openai-apps-sdk-examples

### Model Context Protocol (MCP)
- **Tools Specification**: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- **MCP Discussions**: https://github.com/orgs/modelcontextprotocol/discussions

---

## 8. Changelog

**November 21, 2025**
- Initial research and documentation
- Confirmed PostGrid supports images in letters and postcards
- Identified ChatGPT/MCP limitations (issue #67)
- Decision: Text-only for MVP, revisit when platform supports images
