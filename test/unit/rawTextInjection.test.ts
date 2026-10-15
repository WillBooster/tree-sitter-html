import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';

const root = path.join(import.meta.dirname, '../..');
await Parser.init();
const language = await Language.load(path.join(root, 'tree-sitter-html.wasm'));
const querySource = fs.readFileSync(path.join(root, 'queries/injections.scm'), 'utf8');

for (const tag of ['script', 'style']) {
  test(`preserves ${tag} injection content through lookalike closing names`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, querySource);
    try {
      for (const content of [
        `x</${tag}X><p>still raw</p>`,
        `x</${tag}-x><p>still raw</p>`,
        `x</${tag}\v><p>still raw</p>`,
        `x</${tag}\u00A0><p>still raw</p>`,
        `x</ſ${tag.slice(1)}><p>still raw</p>`,
        'x\0y',
        '<',
        `</${tag.slice(0, 3)}`,
      ]) {
        const tree = parser.parse(`<${tag}>${content}</${tag.toUpperCase()}><p>after</p>`)!;
        try {
          expect(tree.rootNode.hasError, content).toBe(false);
          expect(
            tree.rootNode.namedChildren.map((node) => node.type),
            content
          ).toEqual([`${tag}_element`, 'element']);
          expect(
            query.captures(tree.rootNode).map(({ name, node }) => [name, node.text]),
            content
          ).toEqual([['injection.content', content]]);
          expect(tree.rootNode.lastNamedChild?.text, content).toBe('<p>after</p>');
        } finally {
          tree.delete();
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}
