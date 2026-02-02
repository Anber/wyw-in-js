import * as vm from 'vm';
import { createRequire } from 'module';

import type { Window } from 'happy-dom';

import type { FeatureFlags, StrictOptions } from '@wyw-in-js/shared';
import { isFeatureEnabled } from '@wyw-in-js/shared';

import * as process from './process';

const NOOP = () => {};
const IMPORT_META_ENV = '__wyw_import_meta_env';
const HAPPY_DOM_REQUIRE_HOOK = '__wyw_requireHappyDom';

const nodeRequire = createRequire(import.meta.url);

let importMetaEnvWarned = false;
let happyDomRequireEsmWarned = false;
let happyDomUnavailable = false;

function isErrRequireEsm(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_REQUIRE_ESM'
  );
}

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

type HappyDomExports = {
  GlobalWindow?: new () => Window;
  Window: new () => Window;
};

function requireHappyDom(): HappyDomExports {
  const hook = (globalThis as Record<string, unknown>)[HAPPY_DOM_REQUIRE_HOOK];
  if (typeof hook === 'function') {
    return (hook as () => HappyDomExports)();
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return nodeRequire('happy-dom') as HappyDomExports;
}

function createWindow(): Window | undefined {
  if (happyDomUnavailable) return undefined;

  try {
    const { Window, GlobalWindow } = requireHappyDom();
    const HappyWindow = GlobalWindow || Window;
    const win = new HappyWindow();

    // TODO: browser doesn't expose Buffer, but a lot of dependencies use it
    win.Buffer = Buffer;
    win.Uint8Array = Uint8Array;

    return win;
  } catch (error) {
    if (!isErrRequireEsm(error)) {
      throw error;
    }

    const hasCustomRequireHook =
      typeof (globalThis as Record<string, unknown>)[HAPPY_DOM_REQUIRE_HOOK] ===
      'function';
    if (!hasCustomRequireHook) {
      happyDomUnavailable = true;
    }

    if (happyDomRequireEsmWarned) return undefined;
    happyDomRequireEsmWarned = true;

    // eslint-disable-next-line no-console
    console.warn(
      [
        `[wyw-in-js] DOM emulation is enabled (features.happyDOM), but "happy-dom" could not be loaded in this build-time runtime.`,
        `This usually happens because "happy-dom" is ESM-only and cannot be loaded via require() in this runtime.`,
        ``,
        `WyW will continue without DOM emulation (as if features.happyDOM:false).`,
        ``,
        `To silence this warning: set features: { happyDOM: false }.`,
        `To get real DOM emulation in Node 22+, WyW needs the async ESM eval architecture (v2.0.0),`,
        `or a runtime that supports require(ESM) (Node 24+).`,
      ].join('\n')
    );

    return undefined;
  }
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

function createNothing() {
  return {
    teardown: () => {},
    window: undefined,
  };
}

function createHappyDOMWindow() {
  const win = createWindow();
  if (!win) return createNothing();

  return {
    teardown: () => {
      win.happyDOM.abort();
    },
    window: win,
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
