/** 功能：验证 Git 安装包会被 pi 作为扩展包发现 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("package.json 声明 pi 扩展入口且不依赖本机 file 路径", async () => {
	const packagePath = resolve(import.meta.dirname, "..", "package.json");
	const packageJson = JSON.parse(await readFile(packagePath, "utf-8"));

	assert.equal(packageJson.name, "alps-pi");
	assert.match(packageJson.description, /Personal pi beautification extension/);
	assert.ok(packageJson.keywords?.includes("pi-package"));
	assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
	assert.equal(packageJson.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
	assert.equal(packageJson.dependencies?.["@earendil-works/pi-tui"], undefined);
	assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
	assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-tui"], "*");
});
