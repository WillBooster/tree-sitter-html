import path from 'node:path';

import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';
import { afterAll, expect, test } from 'vitest';

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
    const indented = parser.parse(` \t${source}`)!;
    try {
      expect(indented.rootNode.hasError).toBe(false);
      expectContentRanges(indented.rootNode);
    } finally {
      indented.delete();
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
      const repaired = parser.parse(source.slice(0, 2) + source.slice(3))!;
      try {
        expect(repaired.rootNode.hasError).toBe(false);
        expect(repaired.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual([entity]);
        expectContentRanges(repaired.rootNode);
      } finally {
        repaired.delete();
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
