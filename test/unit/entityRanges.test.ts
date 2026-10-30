import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

test('parses complete named and numeric character-reference ranges', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(entity) @reference');
  try {
    for (const reference of [
      '&frac12;',
      '&sup2;',
      '&CounterClockwiseContourIntegral;',
      '&#128512;',
      '&#1114111;',
      '&#00000000065;',
      '&#x0000000041;',
      '&#X10FFFF;',
      '&#128512',
      '&#x0000000041',
    ]) {
      const tree = parser.parse(`<p>before ${reference} after</p><br>`)!;
      try {
        expect(tree.rootNode.hasError, reference).toBe(false);
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([reference]);
        expect(tree.rootNode.firstNamedChild?.namedChildren.map((node) => node.text)).toEqual([
          '<p>',
          'before ',
          reference,
          ' after',
          '</p>',
        ]);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<br>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('keeps incomplete numeric prefixes and raw element content out of entity nodes', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const source of [
      '<p>&# &#x &#X;</p>',
      '<script>&frac12; &#128512;</script>',
      '<style>&frac12; &#128512;</style>',
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('entity'), source).toHaveLength(0);
        expect(tree.rootNode.firstNamedChild?.text).toBe(source);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
