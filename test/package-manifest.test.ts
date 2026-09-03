/** 功能：验证 Git 安装包会被 pi 作为扩展包发现 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("package.json 声明 pi 扩展入口且不依赖本机 file 路径", async () => {
	const packagePath = resolve(import.meta.dirname, "..", "package.json");
	const packageJson = JSON.parse(await readFile(packagePath, "utf-8"));

	assert.equal(packageJson.name, "alps-pi");
	assert.equal(packageJson.version, "0.2.0");
	assert.match(packageJson.description, /Pi 0\.84\.4\+ TUI beautification extension/);
	assert.equal(packageJson.private, undefined);
	assert.equal(packageJson.license, "MIT");
	assert.equal(packageJson.repository?.url, "git+https://github.com/MrCKR/alps-pi.git");
	assert.equal(packageJson.homepage, "https://github.com/MrCKR/alps-pi#readme");
	assert.equal(packageJson.bugs?.url, "https://github.com/MrCKR/alps-pi/issues");
	assert.ok(packageJson.keywords?.includes("pi-package"));
	assert.ok(packageJson.keywords?.includes("pi-extension"));
	assert.ok(packageJson.files?.includes("index.ts"));
	assert.ok(packageJson.files?.includes("src"));
	assert.ok(packageJson.files?.includes("themes"));
	assert.ok(packageJson.files?.includes("LICENSE"));
	assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
	assert.deepEqual(packageJson.pi?.themes, ["./themes"]);
	assert.equal(packageJson.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
	assert.equal(packageJson.dependencies?.["@earendil-works/pi-tui"], undefined);
	assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
	assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-tui"], "*");
	assert.equal(packageJson.devDependencies?.["@earendil-works/pi-coding-agent"], "^0.84.4");
	assert.equal(packageJson.devDependencies?.["@earendil-works/pi-tui"], "^0.84.4");
	assert.equal(packageJson.dependencies?.["proper-lockfile"], "^4.1.2");
});

test("package 包含 alps 主题且主题 token 完整", async () => {
	const themeDir = resolve(import.meta.dirname, "..", "themes");
	const themePath = resolve(themeDir, "alps.json");
	const licenseFiles = await readdir(themeDir);
	const themeJson = JSON.parse(await readFile(themePath, "utf-8"));

	assert.equal(themeJson.name, "alps");
	assert.match(themeJson.$schema, /theme-schema\.json$/);
	assert.ok(licenseFiles.includes("LICENSE.synthwave-84"));
	assert.equal(Object.keys(themeJson.colors).length, 52);
	assert.equal(themeJson.colors.accent, "variable");
	assert.equal(themeJson.colors.borderAccent, "func");
	assert.equal(themeJson.vars.inputBorder, "#ff8b39");
	for (const token of ["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax"]) {
		assert.equal(themeJson.colors[token], "inputBorder");
	}
	assert.equal(themeJson.colors.bashMode, "keyword");
});
