# Letter IRL Widget Prototypes

These HTML prototypes illustrate how each `_meta.openai/outputTemplate` renders inside the OpenAI Apps SDK. They rely on `window.renderContext.data` (placeholder for Apps SDK data injection) and `window.openai` bridge calls for tool invocation.

## Usage Notes
- Bundle or adapt these templates according to the Apps SDK widget packaging guidance. For quick iteration, you can serve them as static HTML and inject runtime data during development.
- Each template expects the data shape produced by the corresponding MCP tool output documented in `docs/tool-apis.md`.
- Replace the inline styling with your design system as needed; the current CSS favors legible defaults suitable for review builds.
- Ensure `window.openai` helpers (`callTool`, `sendFollowUpMessage`) are available in the runtime environment before shipping.

## Widgets
- `LetterPreviewCard.html` — Renders the preview HTML, required credits, and Send workflow.
- `LetterConfirmationCard.html` — Confirms queuing of the letter and links to status tracking.
- `LetterStatusCard.html` — Shows the delivery timeline, preview thumbnail, and follow-up CTA.
- `BalanceCard.html` — Highlights credit counts and standard letter affordability.
