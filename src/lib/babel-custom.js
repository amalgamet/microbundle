import { createConfigItem } from '@babel/core';
import {
	createBabelInputPluginFactory,
	createBabelOutputPluginFactory,
} from '@rollup/plugin-babel';
import merge from 'lodash.merge';
import {
	parseMappingArgument,
	toReplacementExpression,
} from './option-normalization';
import transformFastRest from './transform-fast-rest';
import { isTruthy } from '../utils';

const ESMODULES_TARGET = {
	esmodules: true,
};

const mergeConfigItems = (type, ...configItemsToMerge) => {
	const mergedItems = [];

	configItemsToMerge.forEach(configItemToMerge => {
		configItemToMerge.forEach(item => {
			const itemToMergeWithIndex = mergedItems.findIndex(
				mergedItem =>
					(mergedItem.name || mergedItem.file.resolved) ===
					(item.name || item.file.resolved),
			);

			if (itemToMergeWithIndex === -1) {
				mergedItems.push(item);
				return;
			}

			mergedItems[itemToMergeWithIndex] = createConfigItem(
				[
					mergedItems[itemToMergeWithIndex].file.resolved,
					merge(mergedItems[itemToMergeWithIndex].options, item.options),
				],
				{
					type,
				},
			);
		});
	});

	return mergedItems;
};

const createConfigItems = (type, items) => {
	return items.map(item => {
		let { name, value, ...options } = item;
		value = value || [require.resolve(name), options];
		return createConfigItem(value, { type });
	});
};

const presetEnvRegex = RegExp(/@babel\/(preset-)?env/);

export const babelInputPlugin = createBabelInputPluginFactory(() => ({
	// Passed the plugin options.
	options({ custom: customOptions, ...pluginOptions }) {
		let defines = {};
		if (customOptions.defines) {
			defines = {
				...customOptions.define,
				...parseMappingArgument(customOptions.defines, toReplacementExpression),
			};
		}

		return {
			// Pull out any custom options that the plugin might have.
			customOptions: {
				pragma: customOptions.pragma || 'h',
				pragmaFrag: customOptions.pragmaFrag || 'Fragment',
				defines,
			},

			// Pass the options back with the two custom options removed.
			pluginOptions,
		};
	},
	config(config, { customOptions }) {
		const defaultPlugins = createConfigItems(
			'plugin',
			[
				!customOptions.typescript && {
					name: '@babel/plugin-transform-flow-strip-types',
				},
				{
					name: '@babel/plugin-transform-react-jsx',
					pragma: customOptions.pragma,
					pragmaFrag: customOptions.pragmaFrag,
				},
				{
					name: '@babel/plugin-proposal-class-properties',
					loose: true,
				},
				isTruthy(customOptions.defines) && {
					name: 'babel-plugin-transform-replace-expressions',
					replace: customOptions.defines,
				},
				{
					name: 'babel-plugin-macros',
				},
			].filter(Boolean),
		);

		const babelOptions = config.options || {};

		// remove preset-modules & preset-env, we don't need polyfills while reading
		babelOptions.presets = babelOptions.presets.filter(preset => {
			return !presetEnvRegex.test(preset.file.request);
		});

		// Merge babelrc & our plugins together
		babelOptions.plugins = mergeConfigItems(
			'plugin',
			defaultPlugins,
			babelOptions.plugins || [],
		);

		babelOptions.generatorOpts = {
			// minified: true,
			// compact: true,
			shouldPrintComment: comment => /[@#]__PURE__/.test(comment),
		};

		return babelOptions;
	},
}));

export const babelOutputPlugin = createBabelOutputPluginFactory(() => ({
	// Passed the plugin options.
	options({ custom: customOptions, ...pluginOptions }) {
		return {
			// Pull out any custom options that the plugin might have.
			customOptions: {
				modern: customOptions.modern,
				targets: customOptions.targets,
				compress: !!customOptions.compress,
			},

			// Pass the options back with the two custom options removed.
			pluginOptions,
		};
	},
	config(config, { customOptions }) {
		const isNodeTarget =
			customOptions.targets && customOptions.targets.node != null;
		const defaultPlugins = createConfigItems(
			'plugin',
			[
				!customOptions.modern && {
					name: 'babel-plugin-transform-async-to-promises',
					inlineHelpers: true,
					externalHelpers: false,
					minify: true,
				},
				!customOptions.modern &&
					!isNodeTarget && {
						value: [
							transformFastRest,
							{
								// Use inline [].slice.call(arguments)
								helper: false,
								literal: true,
							},
							'transform-fast-rest',
						],
					},
				!customOptions.modern && {
					name: '@babel/plugin-transform-regenerator',
					async: false,
				},
			].filter(Boolean),
		);

		const babelOptions = config.options || {};

		const envIdx = (babelOptions.presets || []).findIndex(preset =>
			presetEnvRegex.test(preset.file.request),
		);

		const environmentPreset = customOptions.modern
			? '@babel/preset-modules'
			: '@babel/preset-env';

		if (envIdx !== -1) {
			const preset = babelOptions.presets[envIdx];
			babelOptions.presets[envIdx] = createConfigItem(
				[
					environmentPreset,
					Object.assign(
						merge(
							{
								loose: true,
								useBuiltIns: false,
								targets: customOptions.targets,
							},
							preset.options,
							{
								modules: false,
								exclude: merge(
									['transform-async-to-generator', 'transform-regenerator'],
									(preset.options && preset.options.exclude) || [],
								),
							},
						),
						customOptions.modern ? { targets: ESMODULES_TARGET } : {},
					),
				],
				{
					type: `preset`,
				},
			);
		} else {
			babelOptions.presets = createConfigItems('preset', [
				{
					name: environmentPreset,
					targets: customOptions.modern
						? ESMODULES_TARGET
						: customOptions.targets,
					modules: false,
					loose: true,
					useBuiltIns: false,
					exclude: ['transform-async-to-generator', 'transform-regenerator'],
				},
			]);
		}

		// Merge babelrc & our plugins together
		babelOptions.plugins = mergeConfigItems(
			'plugin',
			defaultPlugins,
			babelOptions.plugins || [],
		);

		babelOptions.generatorOpts = {
			// minified: customOptions.compress,
			// compact: customOptions.compress,
			shouldPrintComment: comment => /[@#]__PURE__/.test(comment),
		};

		return babelOptions;
	},
}));

export default () => {
	return createBabelInputPluginFactory(babelCore => {
		return {
			// Passed the plugin options.
			options({ custom: customOptions, ...pluginOptions }) {
				return {
					// Pull out any custom options that the plugin might have.
					customOptions,

					// Pass the options back with the two custom options removed.
					pluginOptions,
				};
			},

			config(config, { customOptions }) {
				const targets = customOptions.targets;
				const isNodeTarget = targets && targets.node != null;

				const defaultPlugins = createConfigItems(
					'plugin',
					[
						{
							name: '@babel/plugin-syntax-import-meta',
						},
						{
							name: '@babel/plugin-transform-react-jsx',
							pragma: customOptions.pragma || 'h',
							pragmaFrag: customOptions.pragmaFrag || 'Fragment',
						},
						!customOptions.typescript && {
							name: '@babel/plugin-transform-flow-strip-types',
						},
						isTruthy(customOptions.defines) && {
							name: 'babel-plugin-transform-replace-expressions',
							replace: customOptions.defines,
						},
						!customOptions.modern && {
							name: 'babel-plugin-transform-async-to-promises',
							inlineHelpers: true,
							externalHelpers: false,
							minify: true,
						},
						!customOptions.modern &&
							!isNodeTarget && {
								value: [
									transformFastRest,
									{
										// Use inline [].slice.call(arguments)
										helper: false,
										literal: true,
									},
									'transform-fast-rest',
								],
							},
						{
							name: '@babel/plugin-proposal-class-properties',
							loose: true,
						},
						!customOptions.modern && {
							name: '@babel/plugin-transform-regenerator',
							async: false,
						},
						{
							name: 'babel-plugin-macros',
						},
					].filter(Boolean),
				);

				const babelOptions = config.options || {};

				const envIdx = (babelOptions.presets || []).findIndex(preset =>
					presetEnvRegex.test(preset.file.request),
				);

				const environmentPreset = customOptions.modern
					? '@babel/preset-modules'
					: '@babel/preset-env';

				if (envIdx !== -1) {
					const preset = babelOptions.presets[envIdx];
					babelOptions.presets[envIdx] = createConfigItem(
						[
							environmentPreset,
							Object.assign(
								merge(
									{
										loose: true,
										useBuiltIns: false,
										targets: customOptions.targets,
									},
									preset.options,
									{
										modules: false,
										exclude: merge(
											['transform-async-to-generator', 'transform-regenerator'],
											(preset.options && preset.options.exclude) || [],
										),
									},
								),
								customOptions.modern ? { targets: ESMODULES_TARGET } : {},
							),
						],
						{
							type: `preset`,
						},
					);
				} else {
					babelOptions.presets = createConfigItems('preset', [
						{
							name: environmentPreset,
							targets: customOptions.modern
								? ESMODULES_TARGET
								: customOptions.targets,
							modules: false,
							loose: true,
							useBuiltIns: false,
							exclude: [
								'transform-async-to-generator',
								'transform-regenerator',
							],
						},
					]);
				}

				// Merge babelrc & our plugins together
				babelOptions.plugins = mergeConfigItems(
					'plugin',
					defaultPlugins,
					babelOptions.plugins || [],
				);

				babelOptions.generatorOpts = {
					minified: customOptions.compress,
					compact: customOptions.compress,
					shouldPrintComment: comment => /[@#]__PURE__/.test(comment),
				};

				return babelOptions;
			},
		};
	});
};
