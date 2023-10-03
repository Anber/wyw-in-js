let nextIdx = 1;
const processed = new Map<string, number>();

export function getFileIdx(name: string): string {
  if (!processed.has(name)) {
    // eslint-disable-next-line no-plusplus
    processed.set(name, nextIdx++);
  }

  return processed.get(name)!.toString().padStart(5, '0');
}
