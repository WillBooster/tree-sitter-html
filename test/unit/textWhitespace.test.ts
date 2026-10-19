import { afterAll, expect, test } from 'vitest';
import path from 'node:path';

import { Edit, Language, Parser, type Node } from '@willbooster/web-tree-sitter';

await Parser.init();
const parser = new Parser().setLanguage(
  await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'))
);
afterAll(() => parser.delete());

const sources = [
  ' \n<!--x--> \n',
  '<div> \n<!--x--> \n</div>',
  '<p> \n&amp; \n</p>',
  '<div><br> \n<span></span> \n</div>',
  '\n<div>\n  aaa\n  <b> bbb </b>\n</div>\n',
  '<p> a &amp; b <!-- note --> c </p>\n',
  ' \n\t\r\n',
  '\n<div title=" value "> \u00A0text\u3000 </div>\t',
  '\n<script> \n code(); \n </script>\n<style> a {} </style>\n',
];

test.each(sources)('retains complete text ranges around markup in %j', (source) => {
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual(
      source.includes('&amp;') ? ['&amp;'] : []
    );
    expectContentRanges(tree.rootNode);
    tree.edit(
      new Edit({
        startIndex: 0,
        oldEndIndex: 0,
        newEndIndex: 2,
        startPosition: { row: 0, column: 0 },
        oldEndPosition: { row: 0, column: 0 },
        newEndPosition: { row: 0, column: 2 },
      })
    );
    const edited = ' \t' + source;
    const incremental = parser.parse(edited, tree)!;
    const fresh = parser.parse(edited)!;
    try {
      expect(incremental.rootNode.hasError).toBe(false);
      expect(fresh.rootNode.hasError).toBe(false);
      expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
      expectContentRanges(incremental.rootNode);
    } finally {
      incremental.delete();
      fresh.delete();
    }
  } finally {
    tree.delete();
  }
});

test.each(['&amp;', '&#123;', '&#x3b1;'])(
  'recovers the exact character reference %s after a stray less-than sign',
  (entity) => {
    const source = `x < \n${entity} y`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
      expect(tree.rootNode.descendantsOfType('ERROR').map((node) => node.text)).toEqual(['<']);
      expect(
        tree.rootNode.descendantsOfType('entity').map((node) => [node.text, node.startIndex, node.endIndex])
      ).toEqual([[entity, source.indexOf(entity), source.indexOf(entity) + entity.length]]);
      expectContentRanges(tree.rootNode);
      tree.edit(
        new Edit({
          startIndex: 2,
          oldEndIndex: 3,
          newEndIndex: 2,
          startPosition: { row: 0, column: 2 },
          oldEndPosition: { row: 0, column: 3 },
          newEndPosition: { row: 0, column: 2 },
        })
      );
      const edited = source.slice(0, 2) + source.slice(3);
      const incremental = parser.parse(edited, tree)!;
      const fresh = parser.parse(edited)!;
      try {
        expect(incremental.rootNode.hasError).toBe(false);
        expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
        expect(incremental.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual([entity]);
        expectContentRanges(incremental.rootNode);
      } finally {
        incremental.delete();
        fresh.delete();
      }
    } finally {
      tree.delete();
    }
  }
);

function expectContentRanges(node: Node): void {
  if (['document', 'element', 'script_element', 'style_element'].includes(node.type)) {
    expect(node.namedChildren.map((child) => child.text).join('')).toBe(node.text);
    let index = node.startIndex;
    for (const child of node.namedChildren) {
      expect(child.startIndex).toBe(index);
      index = child.endIndex;
    }
    expect(index).toBe(node.endIndex);
  }
  for (const child of node.namedChildren) expectContentRanges(child);
}
