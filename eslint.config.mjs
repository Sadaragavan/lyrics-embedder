// Flat ESLint config. Purpose-built for this repo: it parses TypeScript/TSX and
// enforces the React hook rules (the class of bug behind the React #310 crash),
// without turning on an opinionated style ruleset that would flag pre-existing
// code. Extend `rules` here if stricter checks are wanted later.
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      'out/**',
      'release/**',
      'dist/**',
      'node_modules/**',
      'tests/fixtures/**',
      '**/*.d.ts'
    ]
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
]