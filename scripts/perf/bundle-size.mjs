#!/usr/bin/env node
/**
 * 打包产物尺寸基线：记录启动关键路径与各 chunk 体积。
 *
 * 启动关键路径 = HTML 里的 entry script + modulepreload + stylesheet。
 * 动态 import 的 chunk 不计入，但会单独列出，便于确认 Monaco/Markdown 等重模块
 * 是否又回到了首屏。
 *
 * 用法：node scripts/perf/bundle-size.mjs [--json]
 * 输出：.perf-results/bundle-<timestamp>.json 与 latest.json（均已 gitignore）。
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const outDir = join(root, "out");
const resultsDir = join(root, ".perf-results");

function parseAttr(tag, name) {
	const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
	return match?.[1] ?? null;
}

function collectHtmlRefs(html) {
	const refs = [];
	for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
		const src = parseAttr(match[0], "src");
		if (src) refs.push({ kind: "entry", href: src });
	}
	for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
		const href = parseAttr(match[0], "href");
		if (!href) continue;
		const rel = parseAttr(match[0], "rel")?.toLowerCase() ?? "";
		if (rel.includes("modulepreload")) refs.push({ kind: "modulepreload", href });
		else if (rel.includes("stylesheet")) refs.push({ kind: "stylesheet", href });
	}
	return refs;
}

async function fileSize(path) {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

async function main() {
	const rendererIndex = join(outDir, "renderer", "index.html");
	let html;
	try {
		html = await readFile(rendererIndex, "utf8");
	} catch {
		throw new Error(`Missing ${relative(root, rendererIndex)}. Run "npm run build" first.`);
	}

	const refs = collectHtmlRefs(html);
	const bootAssets = [];
	for (const ref of refs) {
		const path = join(outDir, "renderer", ref.href.replace(/^\//, ""));
		bootAssets.push({ ...ref, file: relative(root, path), bytes: await fileSize(path) });
	}

	const assetsDir = join(outDir, "renderer", "assets");
	let assetFiles = [];
	try {
		assetFiles = await readdir(assetsDir);
	} catch {
		// 构建产物缺失时仍输出 HTML 引用结果。
	}
	const assets = [];
	for (const name of assetFiles) {
		const path = join(assetsDir, name);
		assets.push({ file: relative(root, path), bytes: await fileSize(path) });
	}
	assets.sort((a, b) => b.bytes - a.bytes);

	const result = {
		generatedAt: new Date().toISOString(),
		bootBytes: bootAssets.reduce((sum, asset) => sum + asset.bytes, 0),
		bootAssets,
		mainBytes: await fileSize(join(outDir, "main", "index.js")),
		preloadBytes: await fileSize(join(outDir, "preload", "index.js")),
		largestAssets: assets.slice(0, 25),
	};

	await mkdir(resultsDir, { recursive: true });
	const stamp = result.generatedAt.replace(/[:.]/g, "-");
	await writeFile(join(resultsDir, `bundle-${stamp}.json`), JSON.stringify(result, null, 2));
	await writeFile(join(resultsDir, "bundle-latest.json"), JSON.stringify(result, null, 2));

	const format = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
	console.log(`boot critical path: ${format(result.bootBytes)}`);
	for (const asset of bootAssets) console.log(`  ${asset.kind.padEnd(13)} ${format(asset.bytes).padStart(10)}  ${asset.file}`);
	console.log(`main bundle: ${format(result.mainBytes)}`);
	console.log(`preload: ${format(result.preloadBytes)}`);
	console.log("largest renderer assets:");
	for (const asset of result.largestAssets.slice(0, 10)) {
		console.log(`  ${format(asset.bytes).padStart(10)}  ${asset.file}`);
	}
	console.log(`written: ${relative(root, join(resultsDir, "bundle-latest.json"))}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
