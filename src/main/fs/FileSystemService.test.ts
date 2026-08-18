import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { FileSystemService } from "./FileSystemService";

function makeTempRoot(): string {
	return mkdtempSync(join(tmpdir(), "filesystem-service-"));
}

test("listTree filters ignored names at every depth", async () => {
	const root = makeTempRoot();
	try {
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, "node_modules"));
		mkdirSync(join(root, "dist"));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "src", "node_modules"));
		writeFileSync(join(root, "src", "index.ts"), "");

		const tree = await new FileSystemService().listTree(root);

		const names = tree.map((n) => n.name);
		assert.deepEqual(names, ["src"]);
		const src = tree[0]!;
		assert.equal(src.type, "directory");
		assert.deepEqual(src.children!.map((c) => c.name), ["index.ts"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listTree stops recursing at maxDepth", async () => {
	const root = makeTempRoot();
	try {
		// a/b/c/file.txt — depth 2 (a=0, b=1, c=2) with maxDepth=2
		mkdirSync(join(root, "a", "b", "c"), { recursive: true });
		writeFileSync(join(root, "a", "b", "c", "file.txt"), "");

		const tree = await new FileSystemService().listTree(root, 2);

		assert.equal(tree[0]!.name, "a");
		const a = tree[0]!;
		assert.equal(a.children![0]!.name, "b");
		const b = a.children![0]!;
		// depth 2 == maxDepth：c 仍作为节点出现，但其子树（file.txt）不再递归
		assert.deepEqual(b.children!.map((c) => c.name), ["c"]);
		assert.deepEqual(b.children![0]!.children, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listTree sorts directories first, then names (localeCompare)", async () => {
	const root = makeTempRoot();
	try {
		writeFileSync(join(root, "zeta.txt"), "");
		mkdirSync(join(root, "alpha"));
		writeFileSync(join(root, "mid.txt"), "");
		mkdirSync(join(root, "beta"));

		const tree = await new FileSystemService().listTree(root);

		assert.deepEqual(
			tree.map((n) => `${n.type}:${n.name}`),
			["directory:alpha", "directory:beta", "file:mid.txt", "file:zeta.txt"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listTree builds relativePaths with forward slashes and absolute paths", async () => {
	const root = makeTempRoot();
	try {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "a.ts"), "");

		const tree = await new FileSystemService().listTree(root);

		assert.equal(tree[0]!.relativePath, "src");
		assert.equal(tree[0]!.path, join(root, "src"));
		assert.equal(tree[0]!.children![0]!.relativePath, "src/a.ts");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});