export function pathWithQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, value);
    }
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export function assertPaginationProgress(label: string, cursors: object, seen: Map<string, Set<string>>): void {
  for (const [stream, cursor] of Object.entries(cursors)) {
    let values = seen.get(stream);
    if (!values) {
      values = new Set<string>();
      seen.set(stream, values);
    }
    if (values.has(cursor)) throw new Error(`Atlas ${label} pagination repeated ${stream}`);
    values.add(cursor);
  }
}

export function requireCursor(cursor: string | undefined, name: string): string {
  if (!cursor) {
    throw new Error(`Atlas response set ${name.replace(/^next_/, "has_more_")} without ${name}`);
  }
  return cursor;
}
