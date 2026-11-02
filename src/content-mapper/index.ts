import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { transform, type MapperOptions } from './transform.js';

type Project = { options: MapperOptions } | { errors: string[] };
const projects = new Map<string, Project>();
const allowedOptions = {
	exportMode: ['default', 'named', 'both'],
	localsConvention: ['camelCase', 'camelCaseOnly', 'dashes', 'dashesOnly'],
	scopeBehaviour: ['local', 'global'],
	exportGlobals: [true, false],
};

const connection = createMessageConnection(
	new StreamMessageReader(process.stdin),
	new StreamMessageWriter(process.stdout),
);
connection.onRequest('initialize', () => ({
	positionEncoding: 'utf-16',
	diagnosticSource: 'css-modules',
}));
connection.onRequest('openProject', ({ projectHandle, options = {} }: { projectHandle: string;
	options?: Record<string, unknown>; }) => {
	const optionDiagnostics = Object.entries(options).flatMap(([key, value]) => {
		const allowed: readonly unknown[] | undefined = Object.entries(allowedOptions)
			.find(([name]) => name === key)?.[1];
		if (allowed?.includes(value)) {
			return [];
		}
		return [{
			path: [key],
			code: 1001,
			messageText: `Invalid content mapper option ${JSON.stringify(key)}. Allowed values: ${allowed?.map(candidate => JSON.stringify(candidate)).join(', ') ?? 'none (unknown option)'}.`,
		}];
	});
	if (optionDiagnostics.length === 0) {
		projects.set(projectHandle, { options: options as MapperOptions });
	} else {
		projects.set(projectHandle, {
			errors: optionDiagnostics.map(diagnostic => diagnostic.messageText),
		});
	}
	return { optionDiagnostics };
});
connection.onRequest('transform', ({ projectHandle, content, fileName }: { projectHandle: string;
	content: string;
	fileName: string; }): ReturnType<typeof transform> => {
	const project = projects.get(projectHandle);
	if (!project) {
		throw new Error('Content mapper project is not open or has invalid options.');
	}
	if ('errors' in project) {
		return {
			extension: '.ts',
			text: 'export {};',
			diagnostics: project.errors.map(messageText => ({
				start: 0,
				length: 0,
				code: 1001,
				messageText,
			})),
		};
	}
	return transform(content, fileName, project.options);
});
connection.onRequest('closeProject', ({ projectHandle }: { projectHandle: string }) => {
	projects.delete(projectHandle);
	return {};
});
connection.listen();
