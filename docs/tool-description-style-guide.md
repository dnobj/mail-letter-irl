# Tool Description Style Guide

Last verified: March 17, 2026

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

## Good Patterns

- `Preview a physical postcard draft with a front image and back message. This does not send mail.`
- `Send a physical letter using a draft from a preview tool. Requires a draftId and confirm: true.`
- `Open the image upload widget when a direct file attachment is unavailable or was not passed through.`

## Avoid

- Long `USE THIS TOOL WHEN` / `DO NOT USE THIS TOOL WHEN` matrices
- Step-by-step recovery playbooks better handled by tool schemas, widgets, or internal docs
- Marketing phrasing that is not necessary to operate the tool
