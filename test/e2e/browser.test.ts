import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import { expect, test } from 'vitest';

import htmlUrl from '../../tree-sitter-html.wasm?url';
import { Source, Tree } from '../fixtures/parse.js';

test('parses HTML in a browser, loading the Wasm files over HTTP', async () => {
  await Parser.init({ locateFile: () => runtimeUrl });
  const parser = new Parser();
  parser.setLanguage(await Language.load(htmlUrl));
  expect(parser.parse(Source)?.rootNode.toString()).toBe(Tree);
});
