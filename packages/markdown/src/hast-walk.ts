/** The transforms only visit elements and their direct parent; no generic query engine is needed. */
import type { Element, Nodes, Parents } from 'hast';

/** Pre-order traversal observes children after a transform replaces them. */
export function walkElements(
  tree: Nodes,
  visit: (node: Element, parent: Parents | undefined) => void,
  parent?: Parents,
): void {
  if (tree.type === 'element') visit(tree, parent);
  if ('children' in tree) for (const child of tree.children) walkElements(child, visit, tree);
}
