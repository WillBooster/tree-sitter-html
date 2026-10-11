import path from 'node:path';

import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

import { Source, Tree } from '../fixtures/parse.js';

// The same Worker with and without Node.js compatibility, since the package must run in both.
const Configs = {
  'tree-sitter-html-test': 'wrangler.jsonc',
  'tree-sitter-html-test-no-nodejs-compat': 'wrangler.no-nodejs-compat.jsonc',
};

let harness: TestHarness | undefined;

beforeAll(async () => {
  harness = createTestHarness({
    workers: Object.values(Configs).map((config) => ({
      configPath: path.join(import.meta.dirname, '../fixtures/worker', config),
    })),
  });
  await harness.listen();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

test.each(Object.keys(Configs))(
  'parses HTML in Cloudflare Workers with the imported Wasm modules (%s)',
  async (name) => {
    const response = await harness!.getWorker(name).fetch('http://localhost/', { method: 'POST', body: Source });
    expect(await response.text()).toBe(Tree);
  }
);
