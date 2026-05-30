/** 功能：验证内置 Animations registry 基础契约。 实现者：alps 实现日期：2026-05-29 */

import assert from "node:assert/strict";
import test from "node:test";
import { ANIMATIONS, getAnimation, getAnimationsForCategory, pickRandomAnimation, renderAnimationFrame, resolveAnimationWidth } from "../src/features/animations/index.ts";
import { stripAnsi } from "./helpers.test.ts";

test("Animations registry 保留关键动画名称与分类过滤", () => {
	assert.ok(ANIMATIONS.some((animation) => animation.name === "shimmer"));
	assert.ok(ANIMATIONS.some((animation) => animation.name === "crush"));
	assert.ok(ANIMATIONS.some((animation) => animation.name === "pipeline"));
	assert.equal(getAnimation("shimmer")?.category, "thinking");
	assert.ok(getAnimationsForCategory("thinking").every((animation) => animation.category === "thinking" || animation.category === "both"));
	assert.ok(getAnimationsForCategory("working").every((animation) => animation.category === "working" || animation.category === "both"));
});

test("未知动画 render fallback 到可见帧", () => {
	const lines = renderAnimationFrame("missing", 0, 40, "thinking");
	assert.equal(lines.length, 1);
	assert.match(stripAnsi(lines[0]!), /Thinking/);
});

test("多行动画保留多行 render 能力", () => {
	const lines = renderAnimationFrame("aurora", 0, 20, "thinking");
	assert.equal(lines.length, 3);
});

test("动画宽度按 default/full/数字解析", () => {
	assert.equal(resolveAnimationWidth("default", 100), 50);
	assert.equal(resolveAnimationWidth("full", 100), 96);
	assert.equal(resolveAnimationWidth(80, 60), 56);
});

test("随机动画按行数分组，能覆盖多行动画集合", () => {
	const originalRandom = Math.random;
	try {
		Math.random = () => 0.99;
		const picked = pickRandomAnimation("thinking");
		assert.ok((getAnimation(picked)?.lines ?? 1) > 1);
	} finally {
		Math.random = originalRandom;
	}
});
