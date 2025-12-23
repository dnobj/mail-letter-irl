# MCP Tool API Specifications

The Letter IRL MCP server exposes five tools to the OpenAI Apps SDK. Each tool returns metadata tailored for ChatGPT widgets and respects read-only hints where applicable.

## quote_and_preview_letter (Read-Only)
- **Purpose:** Provide a printable preview and letter cost estimate without creating an order.
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
- **Behavior:** Validate both address blocks (name, street, city, state, postal code, country). If any field is missing, the tool responds with a descriptive error before attempting to render the preview. Otherwise it computes `letterCost` (1 for standard one-page letter) and generates the preview HTML.
- **Output schema:**
  ```json
  {
    "type": "object",
    "required": ["previewHtml", "letterCost", "canSendNow"],
    "properties": {
      "previewHtml": { "type": "string" },
      "letterCost": { "type": "number", "description": "Number of letters this will cost (always 1 for standard letter)" },
      "canSendNow": { "type": "boolean" },
      "reasonCannotSend": { "type": "string" },
      "deliveryClass": { "type": "string" },
      "estimatedDeliveryDays": { "type": "integer" }
    }
  }
  ```
- **Metadata:**
  - `_meta.readOnlyHint = true`
  - `_meta.openai/outputTemplate = "LetterPreviewCard"`
  - `_meta.openai/toolInvocation/invoking = "Generating preview…"`
  - `_meta.openai/toolInvocation/invoked = "Preview ready"`

## send_letter (Mutating)
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
  - No `readOnlyHint`
  - `_meta.openai/outputTemplate = "LetterConfirmationCard"`
  - `_meta.openai/toolInvocation/invoking = "Sending letter…"`
  - `_meta.openai/toolInvocation/invoked = "Letter sent"`

## get_order_status (Read-Only)
- **Purpose:** Retrieve the latest order status or a specific order by `orderId`.
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
  - `_meta.openai/outputTemplate = "LetterStatusCard"`
  - `_meta.openai/toolInvocation/invoking = "Checking letter status…"`
  - `_meta.openai/toolInvocation/invoked = "Latest status"`

## get_account_balance (Read-Only)
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
  - `_meta.openai/outputTemplate = "BalanceCard"`
  - `_meta.openai/toolInvocation/invoking = "Checking letter balance…"`
  - `_meta.openai/toolInvocation/invoked = "Balance updated"`
