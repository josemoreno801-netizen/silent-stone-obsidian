// ESLint 9 flat config. https://eslint.org/docs/latest/use/configure/configuration-files
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
	{
		ignores: ['main.js', 'node_modules/**', 'esbuild.config.mjs'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: 'module',
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'@typescript-eslint/no-explicit-any': 'warn',
		},
	},
];
