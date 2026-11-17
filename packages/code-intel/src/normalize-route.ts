/** Normalize HTTP route paths for cross-stack contract keys. */
export function normalizeRoutePath(path: string): string {
  let p = path.trim();
  if (p === "") return "";
  p = p.replace(/^\/+/, "");
  p = p.toLowerCase();
  p = p.replace(/\{[^}]*\}/g, "{param}");
  p = p.replace(/:[^/]+/g, "{param}");
  p = p.replace(/\$\{[^}]*\}/g, "{param}");
  p = p.replace(/\/+/g, "/");
  p = p.replace(/\/+$/, "");
  return p;
}

export function httpContractKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizeRoutePath(path)}`;
}