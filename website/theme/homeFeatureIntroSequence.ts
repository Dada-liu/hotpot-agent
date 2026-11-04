// 首页卡片入场序列：开场动画结束后先把卡片区滚到视口中间，
// 再逐张飞入。每张卡片交替从页面左上角 / 右上角外围飞向视口中心，
// 在中间借一次方向（不停留、不晃动）后直接飞回自己的卡片位；下一张在
// 上一张离开中心后才抵达中间。全部用 transform + 滚动实现，动画前后
// 页面高度不变。

const SCROLL_DURATION_MS = 520;
// 单卡时长：保持更快的飞行速度
const CARD_DURATION_MS = 900;
// 错峰起飞：上一张刚离开中间，下一张才抵达，中间始终只停一张卡片
const CARD_STAGGER_MS = 380;

type Point = {
	x: number;
	y: number;
};

function lerp(from: number, to: number, ratio: number): number {
	return from + (to - from) * ratio;
}

function easeInOutCubic(progress: number): number {
	return progress < 0.5
		? 4 * progress ** 3
		: 1 - (-2 * progress + 2) ** 3 / 2;
}

// 把卡片区滚到视口中间；返回可取消的完成信号（组件卸载时中断）
export function startFeatureScroll(section: HTMLElement): {
	done: Promise<void>;
	cancel: () => void;
} {
	const maxScroll = Math.max(
		0,
		document.documentElement.scrollHeight - window.innerHeight,
	);
	const rect = section.getBoundingClientRect();
	const targetTop =
		window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
	const to = Math.max(0, Math.min(targetTop, maxScroll));
	const from = window.scrollY;
	const distance = to - from;

	let frame = 0;
	let cancelled = false;
	let resolveDone: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});

	if (Math.abs(distance) < 1) {
		resolveDone();
		return { done, cancel: () => {} };
	}

	const startTime = performance.now();
	const step = (now: number) => {
		if (cancelled) {
			return;
		}
		const progress = Math.min(1, (now - startTime) / SCROLL_DURATION_MS);
		window.scrollTo(0, from + distance * easeInOutCubic(progress));
		if (progress < 1) {
			frame = requestAnimationFrame(step);
		} else {
			resolveDone();
		}
	};
	frame = requestAnimationFrame(step);

	return {
		done,
		cancel: () => {
			if (cancelled) {
				return;
			}
			cancelled = true;
			cancelAnimationFrame(frame);
			resolveDone();
		},
	};
}

// start / mid 都是相对卡片静止位置的位移；fromRight 时旋转方向镜像
function cardKeyframes(start: Point, mid: Point, fromRight: boolean): Keyframe[] {
	const tilt = fromRight ? 8 : -8;
	return [
		{
			offset: 0,
			transform: `translate(${start.x}px, ${start.y}px) scale(0.58) rotate(${tilt}deg)`,
			opacity: 0,
			easing: "cubic-bezier(0.4, 0, 0.6, 1)",
		},
		{
			offset: 0.08,
			transform: `translate(${lerp(start.x, mid.x, 0.3)}px, ${lerp(start.y, mid.y, 0.3)}px) scale(0.7) rotate(${tilt * 0.6}deg)`,
			opacity: 1,
			// 飞到中间前收速，转弯更顺
			easing: "cubic-bezier(0.25, 0.55, 0.3, 1)",
		},
		{
			offset: 0.42,
			transform: `translate(${mid.x}px, ${mid.y}px) scale(1) rotate(0deg)`,
			// 不在中间停留：借过方向立刻加速飞回卡片位
			easing: "cubic-bezier(0.45, 0.05, 0.25, 1)",
		},
		{
			offset: 1,
			transform: "translate(0px, 0px) scale(1) rotate(0deg)",
			opacity: 1,
		},
	];
}

export async function playHomeFeatureIntro(cards: HTMLElement[]): Promise<void> {
	const viewportWidth = document.documentElement.clientWidth;
	const viewportHeight = window.innerHeight;
	const animations: Animation[] = [];

	try {
		for (const [index, card] of cards.entries()) {
			const rect = card.getBoundingClientRect();
			const centerX = rect.left + rect.width / 2;
			const centerY = rect.top + rect.height / 2;
			// 左上角与右上角交替起飞
			const fromRight = index % 2 === 1;
			const start = {
				x: fromRight
					? viewportWidth + rect.width * 0.55 - centerX
					: -rect.width * 0.55 - centerX,
				y: -rect.height * 0.55 - centerY,
			};
			const mid = {
				x: viewportWidth / 2 - centerX,
				y: viewportHeight / 2 - centerY,
			};
			animations.push(
				card.animate(cardKeyframes(start, mid, fromRight), {
					duration: CARD_DURATION_MS,
					delay: index * CARD_STAGGER_MS,
					easing: "linear",
					fill: "both",
				}),
			);
		}

		await Promise.all(animations.map((animation) => animation.finished));
	} catch {
		// 浏览器不支持 WAAPI 或动画被取消（页面切换等）时直接收尾，卡片保持原样
	} finally {
		for (const animation of animations) {
			animation.cancel();
		}
	}
}
