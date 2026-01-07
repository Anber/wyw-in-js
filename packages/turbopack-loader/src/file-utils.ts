import fs from 'fs';
import path from 'path';

export function writeFileIfChanged(filePath: string, content: string) {
  let previous: string | null = null;

  try {
    previous = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  if (previous === content) {
    return false;
  }

  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }

  return true;
}
