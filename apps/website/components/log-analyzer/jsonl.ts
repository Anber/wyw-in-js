export type JsonlParseError = {
  lineNumber: number;
  message: string;
  linePreview: string;
};

export type JsonlProgress = {
  bytesRead: number;
  bytesTotal: number;
  lines: number;
};

type ParseJsonlOptions = {
  onProgress?: (progress: JsonlProgress) => void;
  signal?: AbortSignal;
  yieldEveryLines?: number;
  maxErrors?: number;
};

const createAbortError = () => {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
};

const safePreview = (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length <= 300) return trimmed;
  return `${trimmed.slice(0, 300)}…`;
};

const shouldYield = (lineNumber: number, yieldEveryLines: number) => {
  return yieldEveryLines > 0 && lineNumber % yieldEveryLines === 0;
};

const defaultOptions: Required<
  Pick<ParseJsonlOptions, 'yieldEveryLines' | 'maxErrors'>
> = {
  yieldEveryLines: 5000,
  maxErrors: 25,
};

export async function parseJsonlFile<T>(
  file: File,
  onValue: (value: T, lineNumber: number) => void,
  options: ParseJsonlOptions = {}
) {
  const { yieldEveryLines, maxErrors } = {
    ...defaultOptions,
    ...options,
  };

  let bytesRead = 0;
  let lines = 0;
  const errors: JsonlParseError[] = [];

  const reportProgress = () => {
    options.onProgress?.({
      bytesRead,
      bytesTotal: file.size,
      lines,
    });
  };

  const pushError = (lineNumber: number, line: string, error: unknown) => {
    if (errors.length >= maxErrors) return;
    errors.push({
      lineNumber,
      message: error instanceof Error ? error.message : String(error),
      linePreview: safePreview(line),
    });
  };

  const { signal } = options;

  const ensureNotAborted = () => {
    if (signal?.aborted) {
      throw createAbortError();
    }
  };

  const yieldToBrowser = async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  };

  if (!file.stream) {
    ensureNotAborted();
    const text = await file.text();
    ensureNotAborted();

    const parts = text.split(/\r?\n/);
    for (const line of parts) {
      lines += 1;
      const trimmed = line.trim();
      if (trimmed) {
        try {
          onValue(JSON.parse(trimmed) as T, lines);
        } catch (error) {
          pushError(lines, trimmed, error);
        }

        if (shouldYield(lines, yieldEveryLines)) {
          // eslint-disable-next-line no-await-in-loop
          await yieldToBrowser();
        }
      }
    }

    reportProgress();
    return { errors, lines };
  }

  const reader = file.stream().getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  reportProgress();

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      ensureNotAborted();
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      ensureNotAborted();

      if (done) break;
      if (value) {
        bytesRead += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
      }

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        newlineIdx = buffer.indexOf('\n');

        lines += 1;
        const trimmed = line.trim();
        if (trimmed) {
          try {
            onValue(JSON.parse(trimmed) as T, lines);
          } catch (error) {
            pushError(lines, trimmed, error);
          }

          if (shouldYield(lines, yieldEveryLines)) {
            // eslint-disable-next-line no-await-in-loop
            await yieldToBrowser();
            reportProgress();
          }
        }
      }

      reportProgress();
    }
  } finally {
    reader.releaseLock();
  }

  const tail = buffer.trim();
  if (tail) {
    lines += 1;
    try {
      onValue(JSON.parse(tail) as T, lines);
    } catch (error) {
      pushError(lines, tail, error);
    }
  }

  reportProgress();
  return { errors, lines };
}
