export type OutlineNode = {
  id: string;
  title: string;
  page: number;
  y: number;
  children?: OutlineNode[];
};

export type OutlinePathItem = {
  id: string;
  title: string;
  level: number;
};

type LocatedOutlineNode = {
  node: OutlineNode;
  path: OutlinePathItem[];
};

function isBeforeOrAt(node: OutlineNode, page: number, y: number) {
  return node.page < page || (node.page === page && node.y <= y);
}

function collectLocatedNodes(
  nodes: OutlineNode[],
  parentPath: OutlinePathItem[] = [],
): LocatedOutlineNode[] {
  return nodes.flatMap((node) => {
    const path = [
      ...parentPath,
      { id: node.id, title: node.title, level: parentPath.length + 1 },
    ];
    return [
      { node, path },
      ...collectLocatedNodes(node.children ?? [], path),
    ];
  });
}

export function outlinePathForLocation(
  outline: OutlineNode[],
  page: number,
  y = 0,
): OutlinePathItem[] {
  if (!outline.length) return [];

  let activeRoot = outline[0];
  outline.forEach((root) => {
    if (root.page <= page) activeRoot = root;
  });

  const candidates = collectLocatedNodes([activeRoot])
    .filter(({ node }) => node.id === activeRoot.id || isBeforeOrAt(node, page, y))
    .sort((left, right) => {
      if (left.node.page !== right.node.page) return right.node.page - left.node.page;
      if (left.node.y !== right.node.y) return right.node.y - left.node.y;
      return right.path.length - left.path.length;
    });

  return candidates[0]?.path ?? [
    { id: activeRoot.id, title: activeRoot.title, level: 1 },
  ];
}

export function findOutlineNode(
  outline: OutlineNode[],
  id: string,
): OutlineNode | null {
  for (const node of outline) {
    if (node.id === id) return node;
    const child = findOutlineNode(node.children ?? [], id);
    if (child) return child;
  }
  return null;
}
