// 首页特性卡片入场动画的宿主：包一层默认 HomeFeature，不复制上游结构。
// 与开场动画一样每个标签页会话只播放一次；开场动画结束后先把卡片区
// 滚到视口中间，再逐张飞入。

import { HomeFeature as BasicHomeFeature } from "@rspress/core/theme-original";
import type { ComponentProps } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
	playHomeFeatureIntro,
	startFeatureScroll,
} from "./homeFeatureIntroSequence";
import { isSplashFinished, onSplashFinished } from "./splashState";

const INTRO_SEEN_KEY = "hotpot.homeIntroSeen";
// 开场视频最长 15s 加载超时 + 0.5s 渐隐，留出余量后兜底播放
const SPLASH_WAIT_TIMEOUT_MS = 20000;
// 覆盖层消失后稍等一拍再起飞
const START_DELAY_MS = 120;

// SSR 阶段没有布局，改用 useEffect 避免 useLayoutEffect 警告
const useIsomorphicLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

function introSeen(): boolean {
	try {
		return sessionStorage.getItem(INTRO_SEEN_KEY) === "1";
	} catch {
		// storage 不可用时与开场动画保持一致：不再播放
		return true;
	}
}

function markIntroSeen(): void {
	try {
		sessionStorage.setItem(INTRO_SEEN_KEY, "1");
	} catch {
		// 忽略：下次加载会再次播放
	}
}

export function HomeFeature(props: ComponentProps<typeof BasicHomeFeature>) {
	const rootRef = useRef<HTMLDivElement | null>(null);

	// 用 layout effect 在首帧绘制前隐藏卡片，避免客户端导航回首页时闪一帧
	useIsomorphicLayoutEffect(() => {
		const root = rootRef.current;
		if (!root || introSeen()) {
			return;
		}
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			markIntroSeen();
			return;
		}
		const cards = Array.from(
			root.querySelectorAll<HTMLElement>(".rp-home-feature__item"),
		);
		if (cards.length === 0) {
			return;
		}

		// armed：卡片占位保留但不可见，等待开场动画结束和滚动到位
		root.classList.add("home-feature-intro--armed");
		let started = false;
		let disposed = false;
		let startTimer: number | null = null;
		let waitTimer: number | null = null;
		let unsubscribe: (() => void) | null = null;
		let cancelScroll: (() => void) | null = null;

		const start = (): void => {
			if (started) {
				return;
			}
			started = true;
			if (waitTimer !== null) {
				window.clearTimeout(waitTimer);
				waitTimer = null;
			}
			unsubscribe?.();
			unsubscribe = null;

			// 先把卡片区滚到视口中间，滚完再开始飞入
			const section = root.querySelector<HTMLElement>(".rp-home-feature");
			const scroll = section ? startFeatureScroll(section) : null;
			cancelScroll = scroll ? scroll.cancel : null;
			void (scroll ? scroll.done : Promise.resolve()).then(() => {
				if (disposed) {
					return;
				}
				startTimer = window.setTimeout(() => {
					startTimer = null;
					// armed 与 running 在同一帧切换，动画的 fill: both 接管不可见状态
					root.classList.remove("home-feature-intro--armed");
					root.classList.add("home-feature-intro--running");
					markIntroSeen();
					void playHomeFeatureIntro(cards).finally(() => {
						root.classList.remove("home-feature-intro--running");
					});
				}, START_DELAY_MS);
			});
		};

		if (isSplashFinished()) {
			start();
		} else {
			unsubscribe = onSplashFinished(start);
			waitTimer = window.setTimeout(start, SPLASH_WAIT_TIMEOUT_MS);
		}

		return () => {
			disposed = true;
			cancelScroll?.();
			if (startTimer !== null) {
				window.clearTimeout(startTimer);
			}
			if (waitTimer !== null) {
				window.clearTimeout(waitTimer);
			}
			unsubscribe?.();
			root.classList.remove(
				"home-feature-intro--armed",
				"home-feature-intro--running",
			);
		};
	}, []);

	return (
		<div className="home-feature-intro" ref={rootRef}>
			<BasicHomeFeature {...props} />
		</div>
	);
}
