import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Global test settings
    globals: true,
    environment: 'node',

    // Test file patterns
    include: ['tests/**/*.test.ts'],

    // Setup files run before each test file
    setupFiles: ['./tests/setup.ts'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/mcp/**',  // MCP server entry points
        'src/cli/**',  // CLI tools
        '**/*.d.ts',
      ],
    },

    // Workspace configuration for unit vs integration tests
    // Run unit tests by default, integration tests explicitly
    testTimeout: 10000,

    // Pool configuration
    pool: 'forks',
    singleFork: true,  // Better for database tests
  },

  resolve: {
    alias: {
      '@': '/mnt/c/letter-irl/src',
    },
  },
});
