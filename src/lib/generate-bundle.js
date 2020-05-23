import * as path from 'path';
import { rollup } from 'rollup';
import { getConfigFromPkgJson } from './package-info';
import { babelInputPlugin, babelOutputPlugin } from './babel-custom';
import { terser } from 'rollup-plugin-terser';
import postcss from 'rollup-plugin-postcss';
import autoprefixer from 'autoprefixer';
import cssnano from 'cssnano';
import alias from '@rollup/plugin-alias';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import nodeResolve from '@rollup/plugin-node-resolve';
import json from '@rollup/plugin-json';
import { shouldCssModules, cssModulesConfig } from './css-modules';
import { isTruthy } from '../utils';

const FORMATS = {
	modern: { ext: '.modern.js', format: 'es', modern: true },
	es: { ext: '.esm.js' },
	esm: { ext: '.esm.js' },
	cjs: { ext: '.js' },
	umd: { ext: '.umd.js' },
};

/**
 * @param {string?} external
 * @param {Record<string, string>} dependencies
 * @param {Record<string, string>} peerDependencies
 * @return {string[]}
 */
function getExternals(external, dependencies = {}, peerDependencies = {}) {
	if (external === 'none') {
		return [];
	}

	const peerDeps = Object.keys(peerDependencies || {});
	if (!external) {
		const deps = Object.keys(dependencies || {});
		return ['dns', 'fs', 'path', 'url'].concat(peerDeps, deps);
	}

	return ['dns', 'fs', 'path', 'url'].concat(peerDeps, external.split(','));
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.es6', '.es', '.mjs'];
export async function generateBundle({
	entries,
	outputDir,
	minifyOptions,
	aliases,
	nameCache,
	...options
}) {
	const { pkg } = await getConfigFromPkgJson(options.cwd);

	const useTypescript = false;
	const shebang = {};
	const bundle = await rollup({
		input: entries,
		external: getExternals(
			options.external,
			pkg.dependencies,
			pkg.peerDependencies,
		),
		treeshake: {
			propertyReadSideEffects: false,
		},
		plugins: [
			postcss({
				plugins: [
					autoprefixer(),
					options.compress !== false &&
						cssnano({
							preset: 'default',
						}),
				].filter(Boolean),
				autoModules: shouldCssModules(options),
				modules: cssModulesConfig(options),
				// only write out CSS for the first bundle (avoids pointless extra files):
				inject: false,
				extract: path.resolve(outputDir, `${options.pkg.name}.css`),
			}),
			aliases.length > 0 &&
				alias({
					resolve: EXTENSIONS,
					entries: aliases,
				}),
			nodeResolve({
				mainFields: ['module', 'jsnext', 'main'],
				browser: options.target !== 'node',
				// defaults + .jsx
				extensions: ['.mjs', '.js', '.jsx', '.json', '.node'],
				preferBuiltins: options.target === 'node',
			}),
			commonjs({
				// use a regex to make sure to include eventual hoisted packages
				include: /\/node_modules\//,
			}),
			json(),
			{
				// We have to remove shebang so it doesn't end up in the middle of the code somewhere
				transform: code => ({
					code: code.replace(/^#![^\n]*/, bang => {
						shebang[options.name] = bang;
					}),
					map: null,
				}),
			},
			useTypescript &&
				typescript({
					typescript: require('typescript'),
					tsconfigDefaults: {
						compilerOptions: {
							sourceMap: options.sourcemap,
							declaration: true,
							jsx: 'react',
							jsxFactory:
								// TypeScript fails to resolve Fragments when jsxFactory
								// is set, even when it's the same as the default value.
								options.jsx === 'React.createElement'
									? undefined
									: options.jsx || 'h',
						},
					},
					tsconfig: options.tsconfig,
					tsconfigOverride: {
						compilerOptions: {
							target: 'esnext',
						},
					},
				}),
			babelInputPlugin({
				babelHelpers: 'bundled',
				extensions: EXTENSIONS,
				exclude: 'node_modules/**',
				custom: {
					pragma: options.jsx || 'h',
					pragmaFrag: options.jsxFragment || 'Fragment',
					defines: options.define,
				},
			}),
		].filter(Boolean),
	});

	const formats = options.format.split(',');
	// always compile cjs first if it's there:
	formats.sort((a, b) => (a === 'cjs' ? -1 : a > b ? 1 : 0));
	return Promise.all(
		formats.map((format, index) => {
			const isModern = format === 'modern';

			return bundle.write({
				name: options.name,
				dir: outputDir,
				banner: shebang[options.name],
				format: isModern ? 'es' : format,
				sourcemap: !!options.sourcemap,
				strict: false,
				freeze: false,
				esModule: false,
				entryFileNames: `[name]${FORMATS[format].ext}`,
				chunkFileNames: `[name].chunk${FORMATS[format].ext}`,
				assetFileNames: '[name][extname]',
				plugins: [
					babelOutputPlugin({
						allowAllFormats: true,
						passPerPreset: true, // @see https://babeljs.io/docs/en/options#passperpreset
						custom: {
							modern: isModern,
							targets: options.target === 'node' ? { node: '8' } : undefined,
							compress: options.compress,
						},
					}),
					isTruthy(minifyOptions) &&
						terser({
							sourcemap: true,
							compress: Object.assign(
								{
									keep_infinity: true,
									pure_getters: true,
									// Ideally we'd just get Terser to respect existing Arrow functions...
									// unsafe_arrows: true,
									passes: 10,
								},
								minifyOptions.compress || {},
							),
							output: {
								// By default, Terser wraps function arguments in extra parens to trigger eager parsing.
								// Whether this is a good idea is way too specific to guess, so we optimize for size by default:
								wrap_func_args: false,
							},
							warnings: true,
							ecma: isModern ? 9 : 5,
							toplevel: isModern || format === 'cjs' || format === 'es',
							mangle: Object.assign({}, minifyOptions.mangle || {}),
							nameCache,
						}),
				].filter(Boolean),
			});
		}),
	);
}
