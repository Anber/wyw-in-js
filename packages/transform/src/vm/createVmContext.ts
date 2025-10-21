import * as vm from 'vm';

import type { FeatureFlags, StrictOptions } from '@wyw-in-js/shared';
import { isFeatureEnabled } from '@wyw-in-js/shared';

import * as process from './process';

type Window = any;

const NOOP = () => {};

function createWindow(): Window {
  // happy-dom v20+ is ESM-only. We use require() here for CommonJS builds.
  // In Node.js < 22, this will fail at runtime. Users should ensure they use
  // the ESM build or Node.js 22+ for happy-dom support.
  // For tests, we provide a Jest mock to avoid ESM/CommonJS conflicts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { Window: WindowClass } = require('happy-dom');
  const win = new WindowClass();

  // TODO: browser doesn't expose Buffer, but a lot of dependencies use it
  win.Buffer = Buffer;
  win.Uint8Array = Uint8Array;

  return win;
}

/**
 * `happy-dom` already has required references, so we don't need to set them.
 */
function setReferencePropertyIfNotPresent(
  context: vm.Context,
  key: string
): void {
  if (context[key] === context) {
    return;
  }

  context[key] = context;
}

function createBaseContext(
  win: Window | undefined,
  additionalContext: Partial<vm.Context>
): Partial<vm.Context> {
  const baseContext: vm.Context = win ?? {};

  setReferencePropertyIfNotPresent(baseContext, 'window');
  setReferencePropertyIfNotPresent(baseContext, 'self');
  setReferencePropertyIfNotPresent(baseContext, 'top');
  setReferencePropertyIfNotPresent(baseContext, 'parent');
  setReferencePropertyIfNotPresent(baseContext, 'global');
  setReferencePropertyIfNotPresent(baseContext, 'process');

  baseContext.document = win?.document;
  baseContext.process = process;

  baseContext.clearImmediate = NOOP;
  baseContext.clearInterval = NOOP;
  baseContext.clearTimeout = NOOP;
  baseContext.setImmediate = NOOP;
  baseContext.requestAnimationFrame = NOOP;
  baseContext.setInterval = NOOP;
  baseContext.setTimeout = NOOP;

  // eslint-disable-next-line guard-for-in,no-restricted-syntax
  for (const key in additionalContext) {
    baseContext[key] = additionalContext[key];
  }

  return baseContext;
}

function createHappyDOMWindow() {
  const win = createWindow();

  return {
    teardown: () => {
      win.happyDOM.abort();
    },
    window: win,
  };
}

function createNothing() {
  return {
    teardown: () => {},
    window: undefined,
  };
}

export function createVmContext(
  filename: string,
  features: FeatureFlags<'happyDOM'>,
  additionalContext: Partial<vm.Context>,
  overrideContext: StrictOptions['overrideContext'] = (i) => i
) {
  const isHappyDOMEnabled = isFeatureEnabled(features, 'happyDOM', filename);

  const { teardown, window } = isHappyDOMEnabled
    ? createHappyDOMWindow()
    : createNothing();
  const baseContext = createBaseContext(
    window,
    overrideContext(
      {
        __filename: filename,
        ...additionalContext,
      },
      filename
    )
  );

  const context = vm.createContext(baseContext);

  return {
    context,
    teardown,
  };
}
