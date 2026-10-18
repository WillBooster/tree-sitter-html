import { expect, test } from 'vitest';
import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

test('keeps bare ampersands as text and character references as entities', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  try {
    for (const [source, entities] of [
      ['&', []],
      ['&&', []],
      ['&;', []],
      ['& ', []],
      ['Users & roles', []],
      ['&amp;&', ['&amp;']],
      ['&&#38;&#x26;', ['&#38;', '&#x26;']],
      ['&amp', ['&amp']],
    ] as const) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const nodes = tree.rootNode.namedChildren;
        expect(nodes.map((node) => node.text).join(''), source).toBe(source.replaceAll(' ', ''));
        expect(
          nodes.filter((node) => node.type === 'entity').map((node) => node.text),
          source
        ).toEqual(entities);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
