import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const config = [
  { ignores: ['.next/**', 'copybook/**', 'holdterm/**', 'catalog/**', 'assets/**', 'public/**'] },
  ...nextCoreWebVitals
];

export default config;
