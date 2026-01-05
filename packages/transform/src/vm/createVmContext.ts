import * as vm from 'vm';

import type { Window } from 'happy-dom';

import type { FeatureFlags, StrictOptions } from '@wyw-in-js/shared';
import { isFeatureEnabled } from '@wyw-in-js/shared';

import * as process from './process';

const NOOP = () => {};
const IMPORT_META_ENV = '__wyw_import_meta_env';

let importMetaEnvWarned = false;

function createImportMetaEnvProxy(): Record<string, unknown> {
  const target = Object.create(null) as Record<string, unknown>;

  const warnOnce = () => {
    if (importMetaEnvWarned) return;
    importMetaEnvWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      [
        `[wyw-in-js] import.meta.env was accessed during build-time evaluation, but no env values were provided.`,
        ``,
        `If you're using Vite, make sure @wyw-in-js/vite plugin is enabled (it injects Vite env for evaluation).`,
        `Otherwise provide "__wyw_import_meta_env" via pluginOptions.overrideContext.`,
      ].join('\n')
    );
  };

  return new Proxy(target, {
    get(obj, key) {
      if (typeof key === 'symbol') {
        return Reflect.get(obj, key);
      }

      warnOnce();
      return obj[key];
    },
    has(obj, key) {
      if (typeof key === 'symbol') {
        return Reflect.has(obj, key);
      }

      warnOnce();
      return Reflect.has(obj, key);
    },
    getOwnPropertyDescriptor(obj, key) {
      return Reflect.getOwnPropertyDescriptor(obj, key);
    },
    ownKeys(obj) {
      return Reflect.ownKeys(obj);
    },
    set(obj, key, value) {
      if (typeof key === 'symbol') {
        return Reflect.set(obj, key, value);
      }

      warnOnce();
      return Reflect.set(obj, key, value);
    },
  });
}

function createWindow(): Window {
  const { Window, GlobalWindow } = require('happy-dom');
  const HappyWindow = GlobalWindow || Window;
  const win = new HappyWindow();

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
  const envContext: Partial<vm.Context> = {
    [IMPORT_META_ENV]: createImportMetaEnvProxy(),
  };
  const baseContext = createBaseContext(
    window,
    overrideContext(
      {
        __filename: filename,
        ...envContext,
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
