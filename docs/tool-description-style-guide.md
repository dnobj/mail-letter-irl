# Tool Description Style Guide

Last verified: October 11, 2026

Use tool descriptions to explain capability, critical constraints, and important side effects. Keep them short enough that the model can reliably route tools without wading through a full operating manual.

## Rules

- Start with what the tool does in user terms.
- State whether the tool previews, sends, saves, clears, or retrieves.
- Mention required confirmations or prerequisites when they are operationally necessary.
- Keep necessary purchase guidance when the tool cannot be used without it.
- Prefer one short paragraph over long decision trees.
- Put platform workarounds in a brief sentence, not a long numbered playbook.
- Avoid all-caps urgency, repeated warnings, use-case lists, and internal planner instructions.
- Do not restate field-by-field schema details that are already in the input schema.
- Say what the tool does, never what it does not do or how risky it is: no "This does not send mail", "Nothing is sent by this tool", "Read-only" or "It is safe". ChatGPT's approval dialog flags such sentences as a "Suspicious Instruction" that steers its risk rating (#543, #670). The annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) carry the risk, and `tests/unit/mcp/modelFacingCopy.test.ts` refuses these sentences in every app.
- Where it matters who sends, say where the person sends: "The person sends it with Send on the preview card".

## Good Patterns

- `Preview a physical postcard draft with a front image and back message. The person sends it with Send on the preview card.`
- `Send a physical letter using a draft from a preview tool. Requires a draftId and confirm: true.`
- `Open the image upload widget when a direct file attachment is unavailable or was not passed through.`

## Avoid

- Long `USE THIS TOOL WHEN` / `DO NOT USE THIS TOOL WHEN` matrices
- Step-by-step recovery playbooks better handled by tool schemas, widgets, or internal docs
- Marketing phrasing that is not necessary to operate the tool
