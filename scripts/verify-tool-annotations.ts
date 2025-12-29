#!/usr/bin/env tsx
/**
 * Verify Tool Annotations
 *
 * Checks that MCP tools have the required OpenAI Apps SDK annotations
 * by reading the source files directly.
 *
 * Run with: npx tsx scripts/verify-tool-annotations.ts
 */

import { readFileSync } from "fs";
import { join } from "path";

interface AnnotationCheck {
  tool: string;
  file: string;
  annotation: string;
  found: boolean;
}

const toolsDir = join(process.cwd(), "src", "tools");

// Tools and their expected annotations
const expectedAnnotations: Record<string, { file: string; annotations: string[] }> = {
  send_letter: {
    file: "sendLetter.ts",
    annotations: ["openWorldHint: true", "idempotentHint: true"],
  },
  send_postcard: {
    file: "sendPostcard.ts",
    annotations: ["openWorldHint: true", "idempotentHint: true"],
  },
  set_return_address: {
    file: "setReturnAddress.ts",
    annotations: ["openWorldHint: true"],
  },
  clear_return_address: {
    file: "clearReturnAddress.ts",
    annotations: ["destructiveHint: true"],
  },
};

console.log("🔍 Verifying OpenAI Apps SDK tool annotations...\n");

const results: AnnotationCheck[] = [];

for (const [toolName, config] of Object.entries(expectedAnnotations)) {
  const filePath = join(toolsDir, config.file);
  let content: string;

  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.log(`❌ Could not read file: ${config.file}`);
    continue;
  }

  for (const annotation of config.annotations) {
    const found = content.includes(annotation);
    results.push({
      tool: toolName,
      file: config.file,
      annotation,
      found,
    });
  }
}

// Print results
let allPassed = true;
for (const result of results) {
  const status = result.found ? "✅" : "❌";
  if (!result.found) allPassed = false;
  console.log(`${status} ${result.tool}: ${result.annotation}`);
}

console.log("\n" + "=".repeat(60));

if (allPassed) {
  console.log("✅ All tool annotations verified successfully!");
  process.exit(0);
} else {
  console.log("❌ Some annotations are missing!");
  process.exit(1);
}
