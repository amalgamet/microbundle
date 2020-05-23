import fs from 'fs';
import { resolve, relative, dirname, basename, extname } from 'path';
import { blue } from 'kleur';
import { map, series } from 'asyncro';
import glob from 'tiny-glob/sync';
import autoprefixer from 'autoprefixer';
import cssnano from 'cssnano';
import { rollup, watch } from 'rollup';
import commonjs from '@rollup/plugin-commonjs';
import babel from '@rollup/plugin-babel';
import customBabel from './lib/babel-custom';
import nodeResolve from '@rollup/plugin-node-resolve';
import { terser } from 'rollup-plugin-terser';
import alias from '@rollup/plugin-alias';
import postcss from 'rollup-plugin-postcss';
import typescript from 'rollup-plugin-typescript2';
import json from '@rollup/plugin-json';
import logError from './log-error';
import { isDir, isFile, stdout, isTruthy, removeScope } from './utils';
import { getSizeInfo } from './lib/compressed-size';
import { normalizeMinifyOptions } from './lib/terser';
import {
	parseAliasArgument,
	parseMappingArgument,
	toReplacementExpression,
} from './lib/option-normalization';
import { getConfigFromPkgJson, getName } from './lib/package-info';
import { shouldCssModules, cssModulesConfig } from './lib/css-modules';

// Extensions to use when resolving modules
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.es6', '.es', '.mjs'];

const WATCH_OPTS = {
	exclude: 'node_modules/**',
};

export default async function microbundle(inputOptions) {
	let options = { ...inputOptions };

	options.cwd = resolve(process.cwd(), inputOptions.cwd);
	const cwd = options.cwd;

	const { hasPackageJson, pkg } = await getConfigFromPkgJson(cwd);
	options.pkg = pkg;

	const { finalName, pkgName } = getName({
		name: options.name,
		pkgName: options.pkg.name,
		amdName: options.pkg.amdName,
		hasPackageJson,
		cwd,
	});

	options.name = finalName;
	options.pkg.name = pkgName;

	if (options.sourcemap !== false) {
		options.sourcemap = true;
	}

	options.input = await getInput({
		entries: options.entries,
		cwd,
		source: options.pkg.source,
		module: options.pkg.module,
	});

	options.output = await getOutput({
		cwd,
		output: options.output,
		pkgMain: options.pkg.main,
		pkgName: options.pkg.name,
	});

	options.entries = await getEntries({
		cwd,
		input: options.input,
	});

	options.multipleEntries = options.entries.length > 1;

	let formats = (options.format || options.formats).split(',');
	// always compile cjs first if it's there:
	formats.sort((a, b) => (a === 'cjs' ? -1 : a > b ? 1 : 0));

	let steps = [];
	for (let i = 0; i < options.entries.length; i++) {
		for (let j = 0; j < formats.length; j++) {
			steps.push(
				createConfig(
					options,
					options.entries[i],
					formats[j],
					i === 0 && j === 0,
				),
			);
		}
	}

	if (options.watch) {
		return doWatch(options, cwd, steps);
	}

	let cache;
	let out = await series(
		steps.map(config => async () => {
			const { inputOptions, outputOptions } = config;
			if (inputOptions.cache !== false) {
				inputOptions.cache = cache;
			}
			let bundle = await rollup(inputOptions);
			cache = bundle;
			await bundle.write(outputOptions);
			return await config._sizeInfo;
		}),
	);

	const targetDir = relative(cwd, dirname(options.output)) || '.';
	const banner = blue(`Build "${options.name}" to ${targetDir}:`);
	return `${banner}\n   ${out.join('\n   ')}`;
}

function doWatch(options, cwd, steps) {
	const onBuild = options.onBuild;
	return new Promise((resolve, reject) => {
		const targetDir = relative(cwd, dirname(options.output));
		stdout(blue(`Watching source, compiling to ${targetDir}:`));
		steps.map(options => {
			watch({
				output: options.outputOptions,
				watch: WATCH_OPTS,
				...(options.inputOptions || {}),
			}).on('event', e => {
				if (e.code === 'ERROR') {
					logError(e.error);
				}
				if (e.code === 'END') {
					options._sizeInfo.then(text => {
						stdout(`Wrote ${text.trim()}`);
					});
					if (typeof onBuild === 'function') {
						onBuild(e);
					}
				}
			});
		});
	});
}

async function jsOrTs(cwd, filename) {
	const extension = (await isFile(resolve(cwd, filename + '.ts')))
		? '.ts'
		: (await isFile(resolve(cwd, filename + '.tsx')))
		? '.tsx'
		: '.js';

	return resolve(cwd, `${filename}${extension}`);
}

async function getInput({ entries, cwd, source, module }) {
	const input = [];

	[]
		.concat(
			entries && entries.length
				? entries
				: (source &&
						(Array.isArray(source) ? source : [source]).map(file =>
							resolve(cwd, file),
						)) ||
						((await isDir(resolve(cwd, 'src'))) &&
							(await jsOrTs(cwd, 'src/index'))) ||
						(await jsOrTs(cwd, 'index')) ||
						module,
		)
		.map(file => glob(file))
		.forEach(file => input.push(...file));

	return input;
}

async function getOutput({ cwd, output, pkgMain, pkgName }) {
	let main = resolve(cwd, output || pkgMain || 'dist');
	if (!main.match(/\.[a-z]+$/) || (await isDir(main))) {
		main = resolve(main, `${removeScope(pkgName)}.js`);
	}
	return main;
}

async function getEntries({ input, cwd }) {
	let entries = (
		await map([].concat(input), async file => {
			file = resolve(cwd, file);
			if (await isDir(file)) {
				file = resolve(file, 'index.js');
			}
			return file;
		})
	).filter((item, i, arr) => arr.indexOf(item) === i);
	return entries;
}

// shebang cache map because the transform only gets run once
const shebang = {};

function createConfig(options, entry, format, writeMeta) {
	let { pkg } = options;

	let external = ['dns', 'fs', 'path', 'url'].concat(
		options.entries.filter(e => e !== entry),
	);

	let outputAliases = {};
	// since we transform src/index.js, we need to rename imports for it:
	if (options.multipleEntries) {
		outputAliases['.'] = './' + basename(options.output);
	}

	const moduleAliases = options.alias ? parseAliasArgument(options.alias) : [];

	const peerDeps = Object.keys(pkg.peerDependencies || {});
	if (options.external === 'none') {
		// bundle everything (external=[])
	} else if (options.external) {
		external = external.concat(peerDeps).concat(options.external.split(','));
	} else {
		external = external
			.concat(peerDeps)
			.concat(Object.keys(pkg.dependencies || {}));
	}

	let globals = external.reduce((globals, name) => {
		// valid JS identifiers are usually library globals:
		if (name.match(/^[a-z_$][a-z0-9_$]*$/)) {
			globals[name] = name;
		}
		return globals;
	}, {});
	if (options.globals && options.globals !== 'none') {
		globals = Object.assign(globals, parseMappingArgument(options.globals));
	}

	let defines = {};
	if (options.define) {
		defines = Object.assign(
			defines,
			parseMappingArgument(options.define, toReplacementExpression),
		);
	}

	function replaceName(filename, name) {
		return resolve(
			dirname(filename),
			name + basename(filename).replace(/^[^.]+/, ''),
		);
	}

	let mainNoExtension = options.output;
	if (options.multipleEntries) {
		let name = entry.match(/([\\/])index(\.(umd|cjs|es|m))?\.(mjs|[tj]sx?)$/)
			? mainNoExtension
			: entry;
		mainNoExtension = resolve(dirname(mainNoExtension), basename(name));
	}
	mainNoExtension = mainNoExtension.replace(
		/(\.(umd|cjs|es|m))?\.(mjs|[tj]sx?)$/,
		'',
	);

	let moduleMain = replaceName(
		pkg.module && !pkg.module.match(/src\//)
			? pkg.module
			: pkg['jsnext:main'] || 'x.esm.js',
		mainNoExtension,
	);
	let modernMain = replaceName(
		(pkg.syntax && pkg.syntax.esmodules) || pkg.esmodule || 'x.modern.js',
		mainNoExtension,
	);
	let cjsMain = replaceName(pkg['cjs:main'] || 'x.js', mainNoExtension);
	let umdMain = replaceName(pkg['umd:main'] || 'x.umd.js', mainNoExtension);

	const modern = format === 'modern';

	// let rollupName = safeVariableName(basename(entry).replace(/\.js$/, ''));

	let nameCache = {};
	const bareNameCache = nameCache;
	// Support "minify" field and legacy "mangle" field via package.json:
	const rawMinifyValue = options.pkg.minify || options.pkg.mangle || {};
	let minifyOptions = typeof rawMinifyValue === 'string' ? {} : rawMinifyValue;
	const getNameCachePath =
		typeof rawMinifyValue === 'string'
			? () => resolve(options.cwd, rawMinifyValue)
			: () => resolve(options.cwd, 'mangle.json');

	const useTypescript = extname(entry) === '.ts' || extname(entry) === '.tsx';

	const externalPredicate = new RegExp(`^(${external.join('|')})($|/)`);
	const externalTest =
		external.length === 0 ? id => false : id => externalPredicate.test(id);

	function loadNameCache() {
		try {
			nameCache = JSON.parse(fs.readFileSync(getNameCachePath(), 'utf8'));
			// mangle.json can contain a "minify" field, same format as the pkg.mangle:
			if (nameCache.minify) {
				minifyOptions = Object.assign(
					{},
					minifyOptions || {},
					nameCache.minify,
				);
			}
		} catch (e) {}
	}
	loadNameCache();

	normalizeMinifyOptions(minifyOptions);

	if (nameCache === bareNameCache) nameCache = null;

	let config = {
		inputOptions: {
			// disable Rollup's cache for the modern build to prevent re-use of legacy transpiled modules:
			cache: modern ? false : undefined,

			input: entry,
			external: id => {
				if (id === 'babel-plugin-transform-async-to-promises/helpers') {
					return false;
				}
				if (options.multipleEntries && id === '.') {
					return true;
				}
				return externalTest(id);
			},
			treeshake: {
				propertyReadSideEffects: false,
			},
			plugins: []
				.concat(
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
						extract: !!writeMeta,
					}),
					moduleAliases.length > 0 &&
						alias({
							resolve: EXTENSIONS,
							entries: moduleAliases,
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
							cacheRoot: `./node_modules/.cache/.rts2_cache_${format}`,
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
					// if defines is not set, we shouldn't run babel through node_modules
					isTruthy(defines) &&
						babel({
							babelHelpers: 'bundled',
							babelrc: false,
							compact: false,
							configFile: false,
							include: 'node_modules/**',
							plugins: [
								[
									require.resolve('babel-plugin-transform-replace-expressions'),
									{ replace: defines },
								],
							],
						}),
					customBabel()({
						babelHelpers: 'bundled',
						extensions: EXTENSIONS,
						exclude: 'node_modules/**',
						passPerPreset: true, // @see https://babeljs.io/docs/en/options#passperpreset
						custom: {
							defines,
							modern,
							compress: options.compress !== false,
							targets: options.target === 'node' ? { node: '8' } : undefined,
							pragma: options.jsx || 'h',
							pragmaFrag: options.jsxFragment || 'Fragment',
							typescript: !!useTypescript,
						},
					}),
					options.compress !== false && [
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
							ecma: modern ? 9 : 5,
							toplevel: modern || format === 'cjs' || format === 'es',
							mangle: Object.assign({}, minifyOptions.mangle || {}),
							nameCache,
						}),
						nameCache && {
							// before hook
							options: loadNameCache,
							// after hook
							writeBundle() {
								if (writeMeta && nameCache) {
									fs.writeFile(
										getNameCachePath(),
										JSON.stringify(nameCache, null, 2),
										() => {},
									);
								}
							},
						},
					],
					{
						writeBundle(bundle) {
							config._sizeInfo = Promise.all(
								Object.values(bundle).map(({ code, fileName }) => {
									if (code) {
										return getSizeInfo(code, fileName, options.raw);
									}
								}),
							).then(results => results.filter(Boolean).join('\n'));
						},
					},
				)
				.filter(Boolean),
		},

		outputOptions: {
			paths: outputAliases,
			globals,
			strict: options.strict === true,
			legacy: true,
			freeze: false,
			esModule: false,
			sourcemap: options.sourcemap,
			get banner() {
				return shebang[options.name];
			},
			format: modern ? 'es' : format,
			name: options.name,
			file: resolve(
				options.cwd,
				{
					modern: modernMain,
					es: moduleMain,
					umd: umdMain,
				}[format] || cjsMain,
			),
		},
	};

	return config;
}
