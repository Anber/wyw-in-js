import type { Compiler } from 'webpack';

import type { EventEmitter, IFileReporterOptions } from '@wyw-in-js/transform';
import { createFileReporter } from '@wyw-in-js/transform';

export const sharedState: {
  emitter?: EventEmitter;
} = {};

export class WYWinJSDebugPlugin {
  private readonly onDone: (root: string) => void;

  constructor(options?: IFileReporterOptions) {
    const { emitter, onDone } = createFileReporter(options ?? false);
    sharedState.emitter = emitter;
    this.onDone = onDone;
  }

  apply(compiler: Compiler) {
    compiler.hooks.shutdown.tap('WYWinJSDebug', () => {
      this.onDone(process.cwd());
    });
  }
}
