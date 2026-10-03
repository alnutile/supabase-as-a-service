module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist',
    '.eslintrc.cjs',
    'supabase/functions',
    // Generated build artifact (esbuild bundle of dc-runtime/src/*.ts, marked
    // "do not edit") — a committed build output like dist/, not source to lint.
    'control-plane/demo-user-interface/support.js',
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    '@typescript-eslint/no-explicit-any': 'off',
  },
  overrides: [
    {
      // The Railway production server is Node (ESM), not browser code.
      files: ['server.js'],
      env: { node: true, browser: false },
    },
    {
      // The Chrome extension is plain browser ESM loaded straight by Chrome
      // (no build step, so it can be side-loaded unpacked) and it uses the
      // `chrome.*` extension APIs.
      files: ['extension/**/*.js'],
      env: { browser: true, webextensions: true, es2022: true },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
  ],
}
