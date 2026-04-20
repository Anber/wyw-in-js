import type webpack from 'webpack';

import type { ICache } from './cache';
import { getCacheInstance } from './cache';

export default async function outputCssLoader(
  this: webpack.LoaderContext<{
    cacheProvider: string | ICache | undefined;
    cacheProviderId?: string | undefined;
  }>
) {
  this.async();
  const { cacheProvider, cacheProviderId } = this.getOptions();

  try {
    const cacheInstance = await getCacheInstance(
      cacheProvider,
      cacheProviderId
    );

    const result = await cacheInstance.get(this.resourcePath);
    const dependencies =
      (await cacheInstance.getDependencies?.(this.resourcePath)) ?? [];

    dependencies.forEach((dependency) => {
      this.addDependency(dependency);
    });

    this.callback(null, result);
  } catch (err) {
    this.callback(err as Error);
  }
}
