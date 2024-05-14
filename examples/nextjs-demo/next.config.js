import withWywInJs from '@wyw-in-js/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default withWywInJs(nextConfig, {
  sourceMap: true,
  displayName: true,
});
