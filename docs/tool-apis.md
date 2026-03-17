# MCP Tool API Specifications

**Last Updated:** December 29, 2025
**Purpose:** Complete specification of all MCP tools exposed by Letter IRL

The Letter IRL MCP server exposes **13 tools** to the OpenAI Apps SDK. Tools are organized into four categories: Letter Tools (4), Postcard Tools (2), Account Management (3), and Return Address (4). Each tool returns metadata tailored for ChatGPT widgets and respects read-only hints where applicable.

---

## Letter Tools (4 tools)

### quote_and_preview_letter_text_only (Read-Only)
- **Purpose:** Create a preview and draft for a text-only letter (no images). Maximum ~1600 characters (~24 lines).
- **Layout:** Text-only
- **Input schema:**
  ```json
  {
    "type": "object",
    "required": ["sender", "recipient", "bodyText", "signOff"],
    "properties": {
      "sender": { "$ref": "#/definitions/addressBlock" },
      "recipient": { "$ref": "#/definitions/addressBlock" },
      "bodyText": { "type": "string" },
      "signOff": { "type": "string", "description": "Closing/signature block" }
    },
    "definitions": {
      "addressBlock": {
        "type": "object",
        "required": ["name", "addressLine1", "city", "state", "postalCode", "country"],
        "properties": {
          "name": { "type": "string" },
          "addressLine1": { "type": "string" },
          "addressLine2": { "type": "string" },
          "city": { "type": "string" },
          "state": { "type": "string" },
          "postalCode": { "type": "string" },
          "country": { "type": "string" }
        }
      }
    }
  }
  ```
- **Behavior:** Validate both address blocks (name, street, city, state, postal code, country). If any field is missing, the tool responds with a descriptive error before attempting to render the preview. Otherwise it computes `lettersRequired` (1 for standard one-page letter) and generates the preview HTML.
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": ["previewHtml", "lettersRequired", "canSendNow"],
    "properties": {
      "previewHtml": { "type": "string" },
      "lettersRequired": { "type": "number", "description": "Letters required from balance (always 1 for standard letter)" },
      "canSendNow": { "type": "boolean" },
      "reasonCannotSend": { "type": "string" },
      "deliveryClass": { "type": "string" },
      "deliveryEstimate": { "type": "string" },
      "deliveryDisclaimer": { "type": "string" }
    }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = true`
  - `_meta.openai/outputTemplate = "ui://widgets/LetterPreviewCard.html"`
  - `_meta.openai/toolInvocation/invoking = "Generating preview…"`
  - `_meta.openai/toolInvocation/invoked = "Preview ready"`

### quote_and_preview_letter_with_header_image (Read-Only)
- **Purpose:** Create a preview and draft for a letter with a header/letterhead image at the top. Maximum ~1100 characters (~17 lines).
- **Layout:** Header image (like business letterhead or logo)
- **Input schema:** Same as text-only, plus:
  ```json
  {
    "image": { "$ref": "#/definitions/imageFileParam" }
  }
  ```
- **Behavior:** Downloads and processes header image (resized to fit letterhead area), validates addresses, creates draft.
- **Output schema:** Same as text-only, plus:
  ```json
  {
    "headerImageData": { "type": "string", "description": "Base64 data URI for widget preview" },
    "layoutType": { "type": "string", "enum": ["header_image"] }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = true`
  - `_meta.openai/outputTemplate = "ui://widgets/LetterPreviewCard.html"`
  - `_meta.openai/fileParams = ["image"]` (enables image upload)
  - `_meta.openai/toolInvocation/invoking = "Processing letter with header image…"`
  - `_meta.openai/toolInvocation/invoked = "Preview ready"`

### quote_and_preview_letter_with_image (Read-Only)
- **Purpose:** Create a preview and draft for a letter with an inline image after the signature (like enclosing a photo). Maximum ~800 characters (~12 lines).
- **Layout:** Inline image (image appears after signature)
- **Input schema:** Same as text-only, plus:
  ```json
  {
    "image": { "$ref": "#/definitions/imageFileParam" }
  }
  ```
- **Behavior:** Downloads and processes inline image (resized for printing), validates addresses, creates draft.
- **Output schema:** Same as text-only, plus:
  ```json
  {
    "inlineImageData": { "type": "string", "description": "Base64 data URI for widget preview" },
    "layoutType": { "type": "string", "enum": ["inline_image"] }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = true`
  - `_meta.openai/outputTemplate = "ui://widgets/LetterPreviewCard.html"`
  - `_meta.openai/fileParams = ["image"]` (enables image upload)
  - `_meta.openai/toolInvocation/invoking = "Processing letter with image…"`
  - `_meta.openai/toolInvocation/invoked = "Preview ready"`

### send_letter (Mutating)
- **Purpose:** Consume a draft from `quote_and_preview_letter`, deduct from user's letter balance, persist an order, and queue it for printing/mailing.
- **Input schema:**
  ```json
  {
    "type": "object",
    "required": ["draftId", "confirm"],
    "properties": {
      "draftId": { "type": "string", "description": "Draft ID from quote_and_preview_letter" },
      "confirm": { "type": "boolean", "description": "Must be true or request fails" }
    }
  }
  ```
- **Behavior:** Require `confirm === true`; consume draft (idempotent - retries with same draftId return same result); verify sufficient letters in balance; deduct letter; create order snapshot with timeline (initial state `queued_for_print`). Draft contains the sender, recipient, bodyText, signOff, and letter cost.
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": [
      "orderId",
      "currentStatus",
      "statusTimeline",
      "recipientSummary",
      "lettersRemaining"
    ],
    "properties": {
      "orderId": { "type": "string" },
      "currentStatus": { "type": "string", "enum": ["queued_for_print", "printing", "mailed"] },
      "statusTimeline": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["timestampISO", "statusText"],
          "properties": {
            "timestampISO": { "type": "string" },
            "statusText": { "type": "string" }
          }
        }
      },
      "recipientSummary": {
        "type": "object",
        "required": ["name", "city", "state"],
        "properties": {
          "name": { "type": "string" },
          "city": { "type": "string" },
          "state": { "type": "string" }
        }
      },
      "lettersRemaining": { "type": "number", "description": "Number of letters remaining in user's balance" },
      "previewFirstPageHtml": { "type": "string" }
    }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = false`
  - `_meta.openWorldHint = true` (triggers real-world mail fulfillment)
  - `_meta.openai/outputTemplate = "ui://widgets/LetterConfirmationCard.html"`
  - `_meta.openai/toolInvocation/invoking = "Sending letter…"`
  - `_meta.openai/toolInvocation/invoked = "Letter sent"`

---

## Postcard Tools (2 tools)

### quote_and_preview_postcard (Read-Only)
- **Purpose:** Create a preview and draft for a 6x9 postcard with a front image and back message. Maximum ~500 characters for back message.
- **Input schema:**
  ```json
  {
    "type": "object",
    "required": ["recipient", "message"],
    "properties": {
      "sender": { "$ref": "#/definitions/addressBlock" },
      "recipient": { "$ref": "#/definitions/addressBlock" },
      "message": { "type": "string", "description": "Message for postcard back (max 500 chars)" },
      "image": { "$ref": "#/definitions/imageFileParam" },
      "imageUrl": { "type": "string", "description": "Alternative: direct image URL" },
      "size": { "type": "string", "enum": ["6x9"], "default": "6x9" }
    }
  }
  ```
- **Behavior:** Downloads and processes front image (1800x2700px at 300 DPI for 6x9), validates addresses, creates postcard draft. Sender address is optional (uses saved return address if not provided).
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": ["previewFrontHtml", "previewBackHtml", "lettersRequired", "canSendNow", "draftId", "draftExpiresAt"],
    "properties": {
      "previewFrontHtml": { "type": "string" },
      "previewBackHtml": { "type": "string" },
      "lettersRequired": { "type": "number", "description": "Always 1 for postcard" },
      "canSendNow": { "type": "boolean" },
      "draftId": { "type": "string" },
      "draftExpiresAt": { "type": "string" },
      "message": { "type": "string" },
      "recipientName": { "type": "string" },
      "senderName": { "type": "string" },
      "usedSavedReturnAddress": { "type": "boolean" }
    }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = true`
  - `_meta.openai/outputTemplate = "ui://widgets/PostcardPreviewCard.html"`
  - `_meta.openai/fileParams = ["image"]` (enables image upload)
  - `_meta.openai/toolInvocation/invoking = "Processing postcard…"`
  - `_meta.openai/toolInvocation/invoked = "Postcard preview ready"`

### send_postcard (Mutating)
- **Purpose:** Consume a postcard draft, deduct credits, and queue for printing/mailing.
- **Input schema:**
  ```json
  {
    "type": "object",
    "required": ["draftId", "confirm"],
    "properties": {
      "draftId": { "type": "string" },
      "confirm": { "type": "boolean", "description": "Must be true" }
    }
  }
  ```
- **Behavior:** Same as send_letter but for postcards. Consumes draft idempotently, deducts 1 letter (2 internal credits), queues postcard job.
- **Output schema:** Similar to send_letter output
- **Metadata:**
  - `_meta.readOnlyHint = false`
  - `_meta.openWorldHint = true` (triggers real-world mail fulfillment)
  - `_meta.openai/outputTemplate = "ui://widgets/PostcardConfirmationCard.html"`
  - `_meta.openai/toolInvocation/invoking = "Sending postcard…"`
  - `_meta.openai/toolInvocation/invoked = "Postcard sent"`

---

## Account Management Tools (3 tools)

### get_order_status (Read-Only)
- **Purpose:** Retrieve the status of a specific letter/postcard order by `orderId` or the most recent order if omitted.
- **Input schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "orderId": { "type": "string" }
    }
  }
  ```
- **Behavior:** Pull the requested order (latest if `orderId` omitted); return timeline, summary, and follow-up guidance.
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": [
      "orderId",
      "currentStatus",
      "statusTimeline",
      "recipientSummary",
      "previewThumbnailHtml"
    ],
    "properties": {
      "orderId": { "type": "string" },
      "currentStatus": { "type": "string" },
      "statusTimeline": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["timestampISO", "statusText"],
          "properties": {
            "timestampISO": { "type": "string" },
            "statusText": { "type": "string" }
          }
        }
      },
      "recipientSummary": {
        "type": "object",
        "required": ["name", "city", "state"],
        "properties": {
          "name": { "type": "string" },
          "city": { "type": "string" },
          "state": { "type": "string" }
        }
      },
      "previewThumbnailHtml": { "type": "string" },
      "canSendFollowUp": { "type": "boolean" },
      "followUpSuggestedPrompt": { "type": "string" }
    }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = true`
  - `_meta.openai/outputTemplate = "ui://widgets/LetterStatusCard.html"`
  - `_meta.openai/toolInvocation/invoking = "Checking status…"`
  - `_meta.openai/toolInvocation/invoked = "Status retrieved"`

### list_orders (Read-Only)
- **Purpose:** List all sent letters and postcards for the authenticated user.
- **Input schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "default": 10, "description": "Max results to return" },
      "offset": { "type": "number", "default": 0 }
    }
  }
  ```
- **Behavior:** Returns paginated list of all letters and postcards with status, recipient, and timestamps.
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": ["orders", "total"],
    "properties": {
      "orders": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["orderId", "mailType", "currentStatus", "recipientName", "createdAt"],
          "properties": {
            "orderId": { "type": "string" },
            "mailType": { "type": "string", "enum": ["letter", "postcard"] },
            "currentStatus": { "type": "string" },
            "recipientName": { "type": "string" },
            "createdAt": { "type": "string" }
          }
        }
      },
      "total": { "type": "number" }
    }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = true`
  - `_meta.openai/outputTemplate = "ui://widgets/OrderListCard.html"`

### get_account_balance (Read-Only)
- **Purpose:** Provide the user's remaining letter balance, standard letter affordability, and account identity information.
- **Input schema:**
  ```json
  {
    "type": "object",
    "properties": {}
  }
  ```
- **Behavior:** Return current letter balance, whether a standard letter is affordable, user email, authentication provider, and a user-friendly message with tip about switching accounts.
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": ["lettersRemaining", "canSendStandardLetter"],
    "properties": {
      "lettersRemaining": { "type": "number", "description": "Number of letters remaining in user's balance" },
      "canSendStandardLetter": { "type": "boolean" },
      "message": { "type": "string" },
      "userEmail": { "type": "string" },
      "authProvider": { "type": "string", "enum": ["Google", "Microsoft", "Apple", "GitHub", "Email/Password"] },
      "lettersExpiringSoon": { "type": "number", "description": "Number of letters expiring within 7 days" }
    }
  }
  ```
- **Example Response:**
  ```
  Account: user@example.com (Google)
  Letter Balance: 97 letters remaining.
  ```
- **Metadata:**
  - `_meta.readOnlyHint = true`
  - `_meta.openai/outputTemplate = "ui://widgets/BalanceCard.html"`
  - `_meta.openai/toolInvocation/invoking = "Checking balance…"`
  - `_meta.openai/toolInvocation/invoked = "Balance retrieved"`

---

## Return Address Tools (4 tools)

### set_return_address (Mutating)
- **Purpose:** Save a default return address for the user to be used automatically in all future letters and postcards.
- **Input schema:**
  ```json
  {
    "type": "object",
    "required": ["address"],
    "properties": {
      "address": { "$ref": "#/definitions/addressBlock" }
    }
  }
  ```
- **Behavior:** Validates and saves the return address to the database. Address is validated via provider.
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": ["success", "message"],
    "properties": {
      "success": { "type": "boolean" },
      "message": { "type": "string" },
      "savedAddress": { "$ref": "#/definitions/addressBlock" }
    }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = false`

### get_return_address (Read-Only)
- **Purpose:** Retrieve the user's saved return address.
- **Input schema:** Empty object
- **Behavior:** Returns saved return address or error if none saved.
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": ["hasReturnAddress"],
    "properties": {
      "hasReturnAddress": { "type": "boolean" },
      "address": { "$ref": "#/definitions/addressBlock" },
      "message": { "type": "string" }
    }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = true`

### clear_return_address (Mutating)
- **Purpose:** Remove the user's saved return address.
- **Input schema:**
  ```json
  {
    "type": "object",
    "required": ["confirm"],
    "properties": {
      "confirm": { "type": "boolean", "description": "Must be true" }
    }
  }
  ```
- **Behavior:** Deletes saved return address from database.
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": ["success", "message"],
    "properties": {
      "success": { "type": "boolean" },
      "message": { "type": "string" }
    }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = false`
  - `_meta.destructiveHint = true` (shows deletion warning)
