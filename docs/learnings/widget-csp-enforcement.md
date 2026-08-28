# The "CSP off" pill, and what enforcement will actually change (issue #228)

**Date:** August 23, 2026 · Evidence gathered by inspecting the ChatGPT DOM and by
serving the widgets locally under an enforced policy.

## The pill is not a verdict on our metadata

Every widget render shows a red **CSP off** pill, which read like a rejection of
our declaration. It isn't. In the ChatGPT DOM it is a `<button>`:

```
aria-label="CSP off. Open connector advanced settings"
```

It deep-links to `#settings/Plugins/plugin_<id>` — the connector detail panel —
where **no CSP toggle exists** for a dev-mode app (the panel contains zero
`role="switch"` elements).

**Our declaration is ingested correctly.** That same panel renders our `ui` block
back to us verbatim, camelCase and all:

```json
"csp": {
  "connectDomains":  ["https://chatgpt.com", "https://letter-irl-api-development.up.railway.app"],
  "resourceDomains": ["https://*.oaistatic.com", "https://*.oaiusercontent.com", "https://letter-irl-api-development.up.railway.app"],
  "redirectDomains": ["https://checkout.stripe.com", "https://letter-irl-api-development.up.railway.app"]
}
```

So two of the three hypotheses in #228 are dead: the canonical `ui.csp` key is
**not** being ignored, and the shape is **not** wrong. What remains is that
dev-mode apps render with enforcement off, and no code change flips that. The
pill can only be confirmed green once a non-dev app renders — that check belongs
to submission, not to a code fix.

## What enforcement changes: exactly two thumbnails

Verified by serving `widgets/` locally with a `Content-Security-Policy` header
mirroring `WIDGET_CSP_CANONICAL` and loading each widget. Observed:

- **Blocked:** `ImageUploadCard`'s remote thumbnail for a ChatGPT Library pick.
  The browser reports
  `Loading the image 'https://oaisdmntprcacentral.blob.core.windows.net/...'
  violates the following Content Security Policy directive: "img-src ..."`.
  That Azure blob host is not covered by `https://*.oaiusercontent.com`.
- **Unaffected:** every `data:` URI image (local-upload previews, all
  server-generated letter/postcard/image previews), the inline `<style>` and
  `<script>` every widget uses, and the inlined SVG logo.

### Why the picked image still reaches the mail

This is the part worth remembering, because it is counter-intuitive: **CSP does
not touch the path the image actually travels.**

1. The widget receives the download URL through the `window.openai` bridge —
   a postMessage, not a page fetch. No CSP involvement.
2. `confirm_uploaded_image` relays that URL to the server, which stores it.
3. The preview tool downloads the image **from Node**, where browser CSP has no
   jurisdiction, and turns it into a `data:` URI preview plus the full-quality
   file for the print vendor.
4. The postcard/letter preview card renders that `data:` URI — allowed.

So under enforcement the user picks from the Library, sees a line of text instead
of a thumbnail, taps *Use This Photo*, and the postcard preview appears **with
the image**. They see it one step later, not never.

## The decision

Do **not** add `*.blob.core.windows.net` to `resourceDomains`. It would trust all
of Azure blob storage, the subdomain varies by region, and the only thing bought
is a thumbnail that the next screen renders anyway. Both remote-image sinks in
`ImageUploadCard` instead carry an `onerror` that hides the broken image and
explains itself.

`tests/unit/mcp/heroAppCompliance.test.ts` pins this: the exclusion, the
canonical/legacy lockstep, and the presence of both error handlers. (Those CSP
tests previously asserted on literals they had just written and imported nothing
from `src/` — they are real now.)

## Reproducing the enforced-CSP check

Dev-mode ChatGPT will not do it for you. Serve the widget directory with the
policy attached and watch the console — see the harness described in this
issue's PR, or re-create it with any static server that sets:

```
img-src data: https://*.oaistatic.com https://*.oaiusercontent.com <api-origin>;
connect-src https://chatgpt.com <api-origin>;
script-src 'unsafe-inline'; style-src 'unsafe-inline'; default-src 'none'
```

A widget that renders clean there will render clean under enforcement.
