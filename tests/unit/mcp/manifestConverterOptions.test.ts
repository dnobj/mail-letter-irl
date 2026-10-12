import { describe, expect, it, vi } from 'vitest';

/**
 * The manifest converts each tool's served Zod shapes with the options the SDK's own tools/list handler uses
 * (@modelcontextprotocol/sdk server/mcp.js): strict unions, inputs as their input side and outputs as their output
 * side (#688). No schema served today has a pipe or a union those options would change, so the options are pinned
 * here rather than left to the equality with tools/list, which could not tell.
 */

const calls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@modelcontextprotocol/sdk/server/zod-json-schema-compat.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/server/zod-json-schema-compat.js')>();
  return {
    ...actual,
    toJsonSchemaCompat: (schema: Parameters<typeof actual.toJsonSchemaCompat>[0], options: Record<string, unknown>) => {
      calls.push(options);
      return actual.toJsonSchemaCompat(schema, options as never);
    }
  };
});

import { servedToolJsonSchemas } from '../../../src/mcp/manifest.js';

describe("the manifest's conversion (#688)", () => {
  it("uses the SDK's tools/list options: strict unions, input side for inputs, output side for outputs", () => {
    calls.length = 0;
    servedToolJsonSchemas('get_order_status');
    expect(calls).toEqual([
      { strictUnions: true, pipeStrategy: 'input' },
      { strictUnions: true, pipeStrategy: 'output' }
    ]);
  });
});
