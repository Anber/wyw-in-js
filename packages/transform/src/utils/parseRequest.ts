export type ParsedRequest = {
  filename: string;
  hash: string;
  query: string;
};

const getFirstSuffixIndex = (request: string) => {
  const queryIdx = request.indexOf('?');
  const hashIdx = request.indexOf('#');

  if (queryIdx === -1) return hashIdx;
  if (hashIdx === -1) return queryIdx;

  return Math.min(queryIdx, hashIdx);
};

export const parseRequest = (request: string): ParsedRequest => {
  const firstSuffixIndex = getFirstSuffixIndex(request);
  if (firstSuffixIndex === -1) {
    return { filename: request, hash: '', query: '' };
  }

  const filename = request.slice(0, firstSuffixIndex);

  const queryIdx = request.indexOf('?');
  const hashIdx = request.indexOf('#');

  const query =
    queryIdx === -1
      ? ''
      : request.slice(queryIdx + 1, hashIdx !== -1 ? hashIdx : undefined);
  const hash = hashIdx === -1 ? '' : request.slice(hashIdx + 1);

  return { filename, hash, query };
};

export const stripQueryAndHash = (request: string) =>
  parseRequest(request).filename;
