import { cssClassPositions } from 'css-class-positions';
import { CssSyntaxError } from 'postcss';
import type { CSSModulesOptions } from 'vite';
import { cssModuleExportsToExports } from '../plugin/css-module-exports-to-exports.js';
import { generateTypeModel } from '../plugin/generate-types.js';
import { getLocalesConventionFunction, shouldKeepOriginalExport } from '../plugin/locals-convention.js';
import { transform as transformCss } from '../plugin/transformers/postcss/index.js';
import type { DependencyReference } from '../plugin/transformers/postcss/types.js';
import type { ExportMode } from '../plugin/types.js';

export type MapperOptions = {
	exportMode?: ExportMode;
	localsConvention?: 'camelCase' | 'camelCaseOnly' | 'dashes' | 'dashesOnly';
	scopeBehaviour?: 'global' | 'local';
	exportGlobals?: boolean;
};

type SpanMapping = [number, number, number, number, number, number];

type TransformResult = {
	extension: '.ts';
	text: string;
	mappings?: SpanMapping[];
	diagnostics?: { start: number;
		length: number;
		code: number;
		messageText: string; }[];
};

export const transform = (
	content: string,
	fileName: string,
	options: MapperOptions,
): TransformResult => {
	if (!fileName.endsWith('.module.css')) {
		return {
			extension: '.ts',
			text: 'export {};',
			diagnostics: [{
				start: 0,
				length: 0,
				code: 1002,
				messageText: 'Only plain .module.css files are supported by this content mapper.',
			}],
		};
	}

	const lineStarts = [0];
	for (let i = 0; i < content.length; i += 1) {
		if (content[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}

	try {
		const cssOptions: CSSModulesOptions = options;
		const cssModule = transformCss(content, fileName, cssOptions, false);
		const keepOriginal = shouldKeepOriginalExport(cssOptions);
		const localsConvention = getLocalesConventionFunction(cssOptions);
		const exports = cssModuleExportsToExports(
			cssModule.exports, fileName, keepOriginal, localsConvention,
		);
		const exportMode = options.exportMode ?? 'default';
		const { codeLines, variableToClass } = generateTypeModel(exports, exportMode, true, true);
		const positions = cssClassPositions(content, { fileName });
		const mappings: SpanMapping[] = [];
		let text = '';

		for (const line of codeLines) {
			if (line.mapping) {
				const className = variableToClass.get(line.mapping.variableName);
				const position = className === undefined ? undefined : positions.get(className);
				if (className !== undefined && position) {
					mappings.push([
						text.length + line.mapping.column,
						line.mapping.variableName.length,
						(lineStarts[position.line - 1] ?? 0) + position.column,
						className.length,
						2,
						8,
					]);
				}
			}
			text += `${line.text}\n`;
		}

		if (exportMode === 'named' && Object.keys(exports).length === 0) {
			text = 'export {};\n';
		}

		const dependencies: DependencyReference[] = [
			...Object.values(cssModule.references),
			...Object.values(cssModule.exports).flatMap(exported => (
				typeof exported === 'string' ? [] : exported.composes.filter(composed => composed.type === 'dependency')
			)),
		];
		const seen = new Set<string>();
		for (const dependency of dependencies) {
			const identity = JSON.stringify([dependency.specifier, dependency.name]);
			if (seen.has(identity)) {
				continue;
			}
			seen.add(identity);
			const index = seen.size;
			const specifier = JSON.stringify(dependency.specifier);
			const prefix = `import type * as __css_dependency_${index} from `;
			const sourceStart = content.indexOf(dependency.specifier);
			if (sourceStart !== -1) {
				mappings.push([
					text.length + prefix.length + 1,
					dependency.specifier.length,
					sourceStart,
					dependency.specifier.length,
					0,
					8,
				]);
			}
			text += `${prefix}${specifier};\n`;
			const name = keepOriginal
				? dependency.name
				: (localsConvention?.(dependency.name, dependency.name, fileName) ?? dependency.name);
			const access = exportMode === 'named' ? '' : '.default';
			text += `void ({} as typeof __css_dependency_${index}${access})[${JSON.stringify(name)}];\n`;
		}

		return {
			extension: '.ts',
			text,
			mappings,
		};
	} catch (error) {
		if (!(error instanceof CssSyntaxError)) {
			throw error;
		}
		const start = (lineStarts[(error.line ?? 1) - 1] ?? 0) + (error.column ?? 1) - 1;
		return {
			extension: '.ts',
			text: 'export {};',
			diagnostics: [{
				start,
				length: 0,
				code: 1003,
				messageText: error.reason,
			}],
		};
	}
};
