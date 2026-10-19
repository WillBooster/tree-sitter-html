import path from 'node:path';
import { Edit, Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

test('retains following elements while reporting malformed closing tags', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const source of [
      '<div>x</div ordinary<p>after</p>',
      '<div>x</div/><p>after</p>',
      '<script>x</script/><p>after</p>',
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        const following = tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
        expect(following?.startIndex, source).toBe(source.indexOf('<p'));
        expect(following?.endIndex, source).toBe(source.length);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('preserves following element ranges through an incremental malformed-close edit', () => {
  const parser = new Parser().setLanguage(language);
  const source = '<div>x</div><p>after</p>';
  const previous = parser.parse(source)!;
  try {
    const startIndex = source.indexOf('><p');
    const replacement = ' ordinary';
    previous.edit(
      new Edit({
        startIndex,
        oldEndIndex: startIndex + 1,
        newEndIndex: startIndex + replacement.length,
        startPosition: { row: 0, column: startIndex },
        oldEndPosition: { row: 0, column: startIndex + 1 },
        newEndPosition: { row: 0, column: startIndex + replacement.length },
      })
    );
    const updated = source.slice(0, startIndex) + replacement + source.slice(startIndex + 1);
    const incremental = parser.parse(updated, previous)!;
    const fresh = parser.parse(updated)!;
    try {
      expect(incremental.rootNode.hasError).toBe(true);
      expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
      const following = incremental.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
      expect(following?.startIndex).toBe(updated.indexOf('<p'));
      expect(following?.endIndex).toBe(updated.length);
    } finally {
      incremental.delete();
      fresh.delete();
    }
  } finally {
    previous.delete();
    parser.delete();
  }
});
