import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { afterAll, expect, test } from 'vitest';

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
    const renamed = parser.parse(source.slice(0, index) + 'svg' + source.slice(index + 4))!;
    try {
      expect(renamed.rootNode.hasError).toBe(false);
    } finally {
      renamed.delete();
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
    const completed = parser.parse(`<!${keyword} html><p>after</p>`)!;
    try {
      expect(completed.rootNode.hasError).toBe(false);
      expect(completed.rootNode.firstNamedChild?.firstNamedChild?.text).toBe(' html');
    } finally {
      completed.delete();
    }
  } finally {
    tree.delete();
  }
});
