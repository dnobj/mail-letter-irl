import { describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as vm from "node:vm";
import {
  buildWidgetResourceMeta,
  normalizeHttpsOrigin,
  partitionToolResult
} from "../../../src/mcp/registerTools.js";
import { generateImageOutputZ } from "../../../src/zodSchemas.js";

class MockClassList {
  private readonly values = new Set<string>();

  add(name: string) {
    this.values.add(name);
  }

  remove(name: string) {
    this.values.delete(name);
  }

  toggle(name: string, force?: boolean) {
    const shouldAdd = force ?? !this.values.has(name);
    if (shouldAdd) this.values.add(name);
    else this.values.delete(name);
    return shouldAdd;
  }

  contains(name: string) {
    return this.values.has(name);
  }
}

type MockElement = {
  classList: MockClassList;
  textContent: string;
  src: string;
  onerror: (() => void) | null;
  addEventListener: (name: string, listener: (event?: unknown) => void) => void;
};

async function createWidgetHarness() {
  const widgetPath = path.resolve(__dirname, "../../../widgets/GenerateImageCard.html");
  const source = await fs.readFile(widgetPath, "utf-8");
  const script = source.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("GenerateImageCard module script not found");

  const elementIds = [
    "state-loading",
    "state-preview",
    "state-error",
    "preview-img",
    "error-message",
    "url-display",
    "url-text",
    "btn-copy"
  ];
  const elementListeners = new Map<string, Array<(event?: unknown) => void>>();
  const elements = Object.fromEntries(elementIds.map((id) => [id, {
    classList: new MockClassList(),
    textContent: "",
    src: "",
    onerror: null,
    addEventListener: (name: string, listener: (event?: unknown) => void) => {
      const key = `${id}:${name}`;
      elementListeners.set(key, [...(elementListeners.get(key) ?? []), listener]);
    }
  }])) as Record<string, MockElement>;

  const windowListeners = new Map<string, Array<(event: any) => void>>();
  const parent = {};
  const windowObject: any = {
    openai: undefined,
    parent,
    addEventListener: (name: string, listener: (event: any) => void) => {
      windowListeners.set(name, [...(windowListeners.get(name) ?? []), listener]);
    }
  };
  const documentElement = { classList: new MockClassList() };

  vm.runInNewContext(script, {
    window: windowObject,
    document: {
      documentElement,
      getElementById: (id: string) => elements[id]
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    setTimeout: () => 0
  });

  return {
    elements,
    windowObject,
    emitGlobals() {
      for (const listener of windowListeners.get("openai:set_globals") ?? []) listener({});
    },
    emitToolResult(params: unknown) {
      for (const listener of windowListeners.get("message") ?? []) {
        listener({
          source: parent,
          data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params }
        });
      }
    }
  };
}

describe("generated image result bridge", () => {
  it("keeps the capability URL model-visible and the preview widget-only", () => {
    const result = partitionToolResult(
      {
        message: "Image ready",
        suggestedNextStep: "Preview the postcard",
        generationsRemaining: 4,
        generatedImageUrl: "https://api.example.com/api/temp-image/secret-token",
        generatedImagePreview: "base64-preview"
      },
      { traceId: "trace" }
    );

    expect(result.structuredContent).toEqual({
      message: "Image ready",
      suggestedNextStep: "Preview the postcard",
      generationsRemaining: 4,
      generatedImageUrl: "https://api.example.com/api/temp-image/secret-token"
    });
    expect(result.structuredContent).not.toHaveProperty("generatedImagePreview");
    expect(result._meta).toMatchObject({
      traceId: "trace",
      generatedImagePreview: "base64-preview",
      generatedImageUrl: "https://api.example.com/api/temp-image/secret-token"
    });
  });

  it("omits absent metadata and all heavy model-facing image fields", () => {
    const result = partitionToolResult({
      message: "Preview ready",
      inlineImageData: "inline-base64",
      headerImageData: "header-base64",
      frontImageData: "front-base64"
    });

    expect(result.structuredContent).toEqual({ message: "Preview ready" });
    expect(result._meta).toEqual({});
  });

  it("validates the real structured result and requires a generated image URL", () => {
    const validResult = {
      message: "Image ready",
      suggestedNextStep: "Preview it",
      generationsRemaining: 4,
      generatedImageUrl: "https://api.example.com/api/temp-image/token"
    };

    expect(generateImageOutputZ.safeParse(validResult).success).toBe(true);
    expect(generateImageOutputZ.safeParse({
      message: "Image ready",
      suggestedNextStep: "Preview it",
      generationsRemaining: 4
    }).success).toBe(false);
  });
});

describe("generated image widget contract", () => {
  it("stays loading and does not show an error before a result arrives", async () => {
    const harness = await createWidgetHarness();

    expect(harness.elements["state-loading"].classList.contains("hidden")).toBe(false);
    expect(harness.elements["state-error"].classList.contains("hidden")).toBe(true);
    expect(harness.elements["error-message"].textContent).toBe("");
  });

  it("renders a preview from the current mcp_tool_result metadata envelope", async () => {
    const harness = await createWidgetHarness();
    harness.windowObject.openai = {
      toolResponseMetadata: {
        mcp_tool_result: {
          structuredContent: { generatedImageUrl: "https://api.example.com/current" },
          _meta: { generatedImagePreview: "current-preview" }
        }
      }
    };

    harness.emitGlobals();

    expect(harness.elements["preview-img"].src).toBe("data:image/jpeg;base64,current-preview");
    expect(harness.elements["url-text"].textContent).toBe("https://api.example.com/current");
    expect(harness.elements["state-preview"].classList.contains("hidden")).toBe(false);
  });

  it("recursively unwraps call_tool_result and mcp_tool_result", async () => {
    const harness = await createWidgetHarness();
    harness.windowObject.openai = {
      toolResponseMetadata: {
        call_tool_result: {
          mcp_tool_result: {
            _meta: {
              generatedImagePreview: "wrapped-preview",
              generatedImageUrl: "https://api.example.com/wrapped"
            }
          }
        }
      }
    };

    harness.emitGlobals();

    expect(harness.elements["preview-img"].src).toBe("data:image/jpeg;base64,wrapped-preview");
    expect(harness.elements["url-text"].textContent).toBe("https://api.example.com/wrapped");
  });

  it("supports legacy flat response metadata", async () => {
    const harness = await createWidgetHarness();
    harness.windowObject.openai = {
      toolResponseMetadata: {
        generatedImagePreview: "legacy-preview",
        generatedImageUrl: "https://api.example.com/legacy"
      }
    };

    harness.emitGlobals();

    expect(harness.elements["preview-img"].src).toBe("data:image/jpeg;base64,legacy-preview");
    expect(harness.elements["url-text"].textContent).toBe("https://api.example.com/legacy");
  });

  it("renders a standard ui/notifications/tool-result result", async () => {
    const harness = await createWidgetHarness();

    harness.emitToolResult({
      structuredContent: { generatedImageUrl: "https://api.example.com/notified" },
      _meta: { generatedImagePreview: "notified-preview" }
    });

    expect(harness.elements["preview-img"].src).toBe("data:image/jpeg;base64,notified-preview");
    expect(harness.elements["url-text"].textContent).toBe("https://api.example.com/notified");
  });

  it("falls back to the structuredContent URL when no preview exists", async () => {
    const harness = await createWidgetHarness();
    harness.windowObject.openai = {
      toolOutput: { generatedImageUrl: "https://api.example.com/url-only" }
    };

    harness.emitGlobals();

    expect(harness.elements["preview-img"].src).toBe("https://api.example.com/url-only");
    expect(harness.elements["state-preview"].classList.contains("hidden")).toBe(false);
  });

  it("shows the existing error after a malformed no-image result", async () => {
    const harness = await createWidgetHarness();
    harness.windowObject.openai = { toolOutput: { message: "Generation finished" } };

    harness.emitGlobals();

    expect(harness.elements["state-error"].classList.contains("hidden")).toBe(false);
    expect(harness.elements["error-message"].textContent)
      .toBe("No image was generated. Please try again.");
  });
});

describe("widget image CSP", () => {
  it("publishes canonical and legacy CSP with the exact API origin", () => {
    const meta = buildWidgetResourceMeta("Generated image");

    expect(meta.ui.csp).toEqual({
      connectDomains: ["https://chatgpt.com", "https://api.letterirl.com"],
      resourceDomains: ["https://*.oaistatic.com", "https://api.letterirl.com"]
    });
    expect(meta["openai/widgetCSP"]).toEqual({
      connect_domains: ["https://chatgpt.com", "https://api.letterirl.com"],
      resource_domains: ["https://*.oaistatic.com", "https://api.letterirl.com"]
    });
  });

  it("normalizes a configured API URL to an HTTPS origin", () => {
    expect(normalizeHttpsOrigin("https://dev.example.com/mcp?ignored=true"))
      .toBe("https://dev.example.com");
    expect(normalizeHttpsOrigin("http://dev.example.com/mcp"))
      .toBe("https://api.letterirl.com");
  });
});
