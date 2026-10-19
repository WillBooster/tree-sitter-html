import { afterAll, expect, test } from 'vitest';
import path from 'node:path';

import { Edit, Language, Parser } from '@willbooster/web-tree-sitter';

await Parser.init();
const parser = new Parser().setLanguage(
  await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'))
);
afterAll(() => parser.delete());

test.each([
  '<!doctype html>',
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">',
  '<!DoCtYpE html SYSTEM "about:legacy-compat">',
  '<!doctype\n html  >',
])('exposes the complete declaration body in %s', (declaration) => {
  const source = `${declaration}<hr><p>after</p>`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const doctype = tree.rootNode.firstNamedChild!;
    expect(doctype.type).toBe('doctype');
    expect(doctype.text).toBe(declaration);
    const value = doctype.namedChildren;
    expect(value).toHaveLength(1);
    expect(value[0]!.type).toBe('doctype_value');
    expect([value[0]!.text, value[0]!.startIndex, value[0]!.endIndex]).toEqual([
      declaration.slice(9, -1),
      9,
      declaration.length - 1,
    ]);
    expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');

    const index = source.toLowerCase().indexOf('html');
    const before = source.slice(0, index).split('\n');
    const row = before.length - 1;
    const column = before.at(-1)!.length;
    tree.edit(
      new Edit({
        startIndex: index,
        oldEndIndex: index + 4,
        newEndIndex: index + 3,
        startPosition: { row, column },
        oldEndPosition: { row, column: column + 4 },
        newEndPosition: { row, column: column + 3 },
      })
    );
    const edited = source.slice(0, index) + 'svg' + source.slice(index + 4);
    const incremental = parser.parse(edited, tree)!;
    const fresh = parser.parse(edited)!;
    try {
      expect(incremental.rootNode.hasError).toBe(false);
      expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
      expect(incremental.rootNode.descendantsOfType('doctype_value').map((node) => node.text)).toEqual(
        fresh.rootNode.descendantsOfType('doctype_value').map((node) => node.text)
      );
    } finally {
      incremental.delete();
      fresh.delete();
    }
  } finally {
    tree.delete();
  }
});

test.each(['doctype', 'DOCTYPE'])('retains an erroneous %s declaration while its body is empty', (keyword) => {
  const source = `<!${keyword}><p>after</p>`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(true);
    const doctype = tree.rootNode.firstNamedChild!;
    expect(doctype.type).toBe('doctype');
    expect(doctype.text).toBe(`<!${keyword}>`);
    expect(doctype.namedChildren.map((node) => [node.type, node.text, node.hasError])).toEqual([
      ['doctype_value', '', true],
    ]);
    expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
    tree.edit(
      new Edit({
        startIndex: 9,
        oldEndIndex: 9,
        newEndIndex: 14,
        startPosition: { row: 0, column: 9 },
        oldEndPosition: { row: 0, column: 9 },
        newEndPosition: { row: 0, column: 14 },
      })
    );
    const edited = source.slice(0, 9) + ' html' + source.slice(9);
    const incremental = parser.parse(edited, tree)!;
    const fresh = parser.parse(edited)!;
    try {
      expect(incremental.rootNode.hasError).toBe(false);
      expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
      expect(incremental.rootNode.firstNamedChild?.firstNamedChild?.text).toBe(' html');
    } finally {
      incremental.delete();
      fresh.delete();
    }
  } finally {
    tree.delete();
  }
});
