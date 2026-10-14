import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';

const root = path.join(import.meta.dirname, '../..');
await Parser.init();
const language = await Language.load(path.join(root, 'tree-sitter-html.wasm'));
const querySource = fs.readFileSync(path.join(root, 'queries/injections.scm'), 'utf8');

for (const tag of ['script', 'style']) {
  test(`preserves ${tag} injection content when an end tag is unfinished`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, querySource);
    try {
      for (const content of ['x', `x</${tag}`, `x</${tag}\v><p>still raw</p>`]) {
        const tree = parser.parse(`<${tag}>${content}`)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([`${tag}_element`]);
          expect(query.captures(tree.rootNode).map(({ name, node }) => [name, node.text])).toEqual([
            ['injection.content', content],
          ]);
        } finally {
          tree.delete();
        }
      }
      const emptyTree = parser.parse(`<${tag}>`)!;
      try {
        expect(emptyTree.rootNode.hasError).toBe(false);
        expect(emptyTree.rootNode.namedChildren.map((node) => node.type)).toEqual([`${tag}_element`]);
        expect(query.captures(emptyTree.rootNode)).toEqual([]);
      } finally {
        emptyTree.delete();
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}

for (const tag of ['script', 'style']) {
  test(`does not inject ${tag} into custom names or markup inside tags`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, querySource);
    try {
      for (const suffix of ['!x', '<', '\v', '\u00A0']) {
        const name = `${tag}${suffix}`;
        const tree = parser.parse(`<${name}>text</${name}>`)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['element']);
          expect(tree.rootNode.firstNamedChild?.firstNamedChild?.firstNamedChild?.text).toBe(name);
          expect(query.captures(tree.rootNode)).toEqual([]);
        } finally {
          tree.delete();
        }
      }
      for (const source of [
        `<${tag}!x>y`,
        `<${tag}</div>a</div>b`,
        `<div =<${tag}><div>`,
        `</${tag}<<${tag}>. <`,
        `<div <${tag}>text</${tag}>`,
        `<div a=<${tag}>text</div>`,
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(query.captures(tree.rootNode)).toEqual([]);
        } finally {
          tree.delete();
        }
      }
      const control = parser.parse(`<div =<${tag}></div><${tag} data-x="<other>">real`)!;
      try {
        expect(control.rootNode.hasError).toBe(false);
        expect(query.captures(control.rootNode).map(({ node }) => node.text)).toEqual(['real']);
      } finally {
        control.delete();
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}
