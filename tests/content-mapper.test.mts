import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
	mkdtemp, mkdir, writeFile, readdir, symlink, rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import process from 'node:process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = path.join(root, 'node_modules/typescript-native/bin/tsc');

const compile = async (
	t: TestContext,
	files: Record<string, string>,
	options = {},
	compilerOptions = {},
) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'css-mapper-'));
	t.after(() => rm(directory, {
		recursive: true,
		force: true,
	}));
	await mkdir(path.join(directory, 'node_modules'));
	await symlink(root, path.join(directory, 'node_modules/vite-css-modules'), 'junction');
	for (const [name, content] of Object.entries(files)) {
		await writeFile(path.join(directory, name), content);
	}
	await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			noEmit: true,
			strict: true,
			module: 'esnext',
			moduleResolution: 'bundler',
			types: [],
			noUnusedLocals: true,
			...compilerOptions,
		},
		files: ['index.ts'],
		contentMappers: [{
			package: 'vite-css-modules',
			extensions: ['.module.css'],
			options,
		}],
	}));
	const result = spawnSync(process.execPath, [compiler, '-p', directory, '--runExternalCode', '--pretty', 'false'], {
		encoding: 'utf8',
		timeout: 20_000,
	});
	assert.ifError(result.error);
	const entries = await readdir(directory);
	assert.equal(entries.some(name => name.endsWith('.d.ts')), false);
	return {
		status: result.status,
		output: result.stdout + result.stderr,
	};
};

type Result = Awaited<ReturnType<typeof compile>>;

const pass = (result: Result) => assert.equal(result.status, 0, result.output);
const fail = (result: Result, pattern: RegExp) => {
	assert.notEqual(result.status, 0, result.output);
	assert.match(result.output, pattern);
};

test('exact default exports work in ESM and CommonJS consumers without generated files', async (t) => {
	for (const module of ['esnext', 'nodenext']) {
		pass(await compile(t, {
			'index.ts': 'import styles from "./style.module.css"; export const value: string = styles.drawer;',
			'style.module.css': '.drawer { color: red; }',
		}, {}, {
			module,
			moduleResolution: module === 'nodenext' ? 'nodenext' : 'bundler',
			ignoreDeprecations: '6.0',
		}));
	}
});

test('rejects typos, missing imports, global selectors, and wrong value types', async (t) => {
	for (const [code, error] of [
		['styles.darwer', /darwer/],
		['styles.global', /global/],
		['styles.drawer = "changed"', /read-only/],
		['const value: number = styles.drawer; export { value }', /not assignable/],
	] as const) {
		fail(await compile(t, {
			'index.ts': `import styles from './style.module.css'; ${code};`,
			'style.module.css': '.drawer {} :global(.global) {}',
		}), error);
	}
	fail(await compile(t, { 'index.ts': 'import styles from "./missing.module.css"; export { styles };' }), /Cannot find module/);
});

test('supports export modes, empty modules, and naming conventions', async (t) => {
	for (const exportMode of ['default', 'both', 'named']) {
		const source = exportMode === 'named' ? 'import { fooBar } from "./style.module.css"; export { fooBar };' : 'import styles from "./style.module.css"; export const value = styles.fooBar;';
		pass(await compile(t, {
			'index.ts': source,
			'style.module.css': '.foo-bar {}',
		}, {
			exportMode,
			localsConvention: 'camelCaseOnly',
		}));
		pass(await compile(t, {
			'index.ts': 'import * as styles from "./style.module.css"; export { styles };',
			'style.module.css': '',
		}, { exportMode }));
	}
	fail(await compile(t, {
		'index.ts': 'import styles from "./style.module.css"; export const value = styles["foo-bar"];',
		'style.module.css': '.foo-bar {}',
	}, { localsConvention: 'camelCaseOnly' }), /foo-bar/);
});

test('checks composed dependencies with the TypeScript module graph', async (t) => {
	const files = {
		'index.ts': 'import styles from "./style.module.css"; export const value = styles.drawer;',
		'style.module.css': '.drawer { composes: base from "./base.module.css"; }',
		'base.module.css': '.base {}',
	};
	pass(await compile(t, files));
	fail(await compile(t, {
		...files,
		'base.module.css': '.renamed {}',
	}), /base/);
	const { 'base.module.css': omitted, ...missing } = files;
	fail(await compile(t, missing), /Cannot find module/);
	pass(await compile(t, {
		...files,
		'base.module.css': '.base { composes: drawer from "./style.module.css"; }',
	}));
});

test('reports malformed CSS and invalid mapper settings', async (t) => {
	fail(await compile(t, {
		'index.ts': 'import "./style.module.css";',
		'style.module.css': '.drawer {',
	}), /Unclosed block/);
	fail(await compile(t, {
		'index.ts': 'import "./style.module.css";',
		'style.module.css': '.a {}',
	}, { localsConvention: 'typo' }), /Invalid content mapper option/);
});

test('uses unsaved content, isolates projects, and maps definitions back to CSS', async (t) => {
	const child = spawn(process.execPath, [path.join(root, 'dist/content-mapper/index.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
	const connection = createMessageConnection(
		new StreamMessageReader(child.stdout),
		new StreamMessageWriter(child.stdin),
	);
	connection.listen();
	t.after(() => {
		connection.dispose();
		child.kill();
	});
	const initialized = await connection.sendRequest<{ positionEncoding: string }>('initialize', { positionEncodings: ['utf-16'] });
	assert.equal(initialized.positionEncoding, 'utf-16');
	await connection.sendRequest('openProject', {
		projectHandle: 'a',
		options: { localsConvention: 'camelCaseOnly' },
		compilerOptions: {},
		configFileName: '',
	});
	await connection.sendRequest('openProject', {
		projectHandle: 'b',
		compilerOptions: {},
		configFileName: '',
	});
	const content = '/* 😀 */\r\n.foo-bar { color: red; }';
	const request = {
		fileName: '/not-on-disk/style.module.css',
		content,
	};
	const a = await connection.sendRequest<{ text: string;
		mappings: [number, number, number, number][]; }>('transform', {
		...request,
		projectHandle: 'a',
	});
	const b = await connection.sendRequest<{ text: string;
		mappings: [number, number, number, number][]; }>('transform', {
		...request,
		projectHandle: 'b',
	});
	assert.match(a.text, /fooBar/);
	assert.match(b.text, /"foo-bar"/);
	assert.ok(a.mappings.some(mapping => content.slice(mapping[2], mapping[2] + mapping[3]) === 'foo-bar'));
	const edited = await connection.sendRequest<{ text: string;
		mappings: [number, number, number, number][]; }>('transform', {
		...request,
		content: '.changed {}',
		projectHandle: 'a',
	});
	assert.match(edited.text, /changed/);
	assert.doesNotMatch(edited.text, /fooBar/);
	await connection.sendRequest('closeProject', { projectHandle: 'a' });
	await assert.rejects(connection.sendRequest<{ text: string;
		mappings: [number, number, number, number][]; }>('transform', {
		...request,
		projectHandle: 'a',
	}), /not open/);
	const remaining = await connection.sendRequest<{ text: string }>('transform', {
		...request,
		projectHandle: 'b',
	});
	assert.match(remaining.text, /foo-bar/);
});

test('checks value imports and explicit ICSS exports', async (t) => {
	const files = {
		'index.ts': 'import styles from "./style.module.css"; export const value: string = styles.drawer;',
		'style.module.css': '@value tone from "./base.module.css"; .drawer { color: tone; }',
		'base.module.css': ':export { tone: red; }',
	};
	pass(await compile(t, files));
	fail(await compile(t, {
		...files,
		'base.module.css': ':export { renamed: red; }',
	}), /tone/);
});
