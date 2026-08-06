/** The nested shape the report's Files panel renders. */
export interface TreeNode {
  name: string;
  type: "file" | "folder";
  children?: TreeNode[];
  /** Issue count, attached during assembly; absent for folders and clean files. */
  badge?: number;
}

/**
 * Flat paths → a nested tree, folders first then files, each alphabetical.
 * Every ingested path is included, reviewed or not: a student reading the
 * report should see the project they submitted, not just its source files.
 */
export function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const path of [...paths].sort()) {
    const parts = path.split("/").filter(Boolean);
    let level = root;

    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const existing = level.find((n) => n.name === part && n.type === (isFile ? "file" : "folder"));
      if (existing) {
        level = existing.children ?? (existing.children = []);
        return;
      }
      const node: TreeNode = isFile ? { name: part, type: "file" } : { name: part, type: "folder", children: [] };
      level.push(node);
      if (!isFile) level = node.children!;
    });
  }

  return sortTree(root);
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) if (node.children) sortTree(node.children);
  return nodes;
}

/** Stamps issue counts onto the tree's file nodes, keyed by full path. */
export function applyBadges(nodes: TreeNode[], countsByPath: Map<string, number>, prefix = ""): TreeNode[] {
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === "folder") {
      applyBadges(node.children ?? [], countsByPath, path);
    } else {
      const count = countsByPath.get(path);
      if (count) node.badge = count;
    }
  }
  return nodes;
}
