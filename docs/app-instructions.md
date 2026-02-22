# App Instructions (Manifest Guidance)

Use the following text in the ChatGPT App manifest so the assistant gathers complete mailing details before calling Letter IRL tools. When the MCP HTTP server is running (`npm run mcp:http`), the manifest file is hosted at `https://<your-host>/manifest.json` (configurable via env vars) so ChatGPT can ingest the tool schemas directly.

> **Letter IRL Instructions**  
> 1. Collect complete sender and recipient address blocks before calling any Letter IRL tool. Each block must include: `name`, `addressLine1`, optional `addressLine2`, `city`, `state`, `postalCode`, and `country`.  
> 2. If a user only provides a postal code, infer the missing city/state from that ZIP; if inference fails, ask for clarification instead of calling the tool.  
> 3. Only call `quote_and_preview_letter` when both address blocks, `bodyText`, and `signOff` are ready. Use separate fields (`bodyText` for the letter content, `signOff` for the closing/signature).  
> 4. Example payload:
>    ```json
>    {
>      "sender": {
>        "name": "Ethan Hawk",
>        "addressLine1": "1610 Essentia Way",
>        "city": "Overland Park",
>        "state": "KS",
>        "postalCode": "66210",
>        "country": "USA"
>      },
>      "recipient": {
>        "name": "Jay Blue",
>        "addressLine1": "123 Elm Street",
>        "city": "Beverly Hills",
>        "state": "CA",
>        "postalCode": "90210",
>        "country": "USA"
>      },
>      "bodyText": "...",
>      "signOff": "Sincerely,\nEthan"
>    }
>    ```  
> 5. After previewing, only call `send_letter` when the user explicitly approves; ensure `confirm: true` is set in the payload.  
> 6. `get_order_status` and `get_account_balance` are read-only; never assume a letter was mailed without checking their responses.  
> 7. If the user requests special formats (color printing, postcards), explain that v1 supports only standard First Class letters.
> 8. When a user requests image generation for their mail, prefer ChatGPT's native image generation if available. The native image can then be attached directly to a preview tool call. Only use the generate_image tool as a fallback when native generation is unavailable or fails.
> 9. When a user wants to include a photo, prefer receiving it as a direct file attachment. Only use the upload_image widget if the attachment wasn't received by the preview tool or if the user is experiencing upload issues.

Embed or adapt this block in the manifest “App instructions” so the assistant consistently gathers the required address fields.
