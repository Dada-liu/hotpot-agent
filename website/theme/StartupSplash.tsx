// 官网启动动画：首次进入站点时全屏播放透明背景 WebM（白底 + 黑/橙图形），
// 播完或点击任意处后直接卸载覆盖层；用 sessionStorage 记住，后续刷新不再展示。
// 新开标签页算一次新的访问，会重新播放。
// 覆盖层消失（或本次不播放）时通过 splashState 通知首页卡片入场动画起飞。
// 视频在 HTML 解析阶段通过 rspress.config.ts 的 head 预加载；
// 首帧就绪前在页面中间显示橙色圆环 loading。

import { normalizeImagePath } from "@rspress/core/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { markSplashFinished } from "./splashState";

const VIDEO_SRC = "/video/startMV_alpha_282.webm";
// 视频迟迟加载不出来时不遮挡页面
const LOAD_TIMEOUT_MS = 15000;
// 结束渐隐时长
const FADE_MS = 500;
const SPLASH_SEEN_KEY = "hotpot.splashSeen";

function splashSeen(): boolean {
	try {
		return sessionStorage.getItem(SPLASH_SEEN_KEY) === "1";
	} catch {
		// storage 不可用（隐私模式等）时不再反复弹
		return true;
	}
}

function markSplashSeen(): void {
	try {
		sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
	} catch {
		// 忽略：下次加载会再次展示
	}
}

export function StartupSplash() {
	// 首帧与 SSR 都不渲染，等客户端确认未看过再挂载，避免 hydration 不一致
	const [visible, setVisible] = useState(false);
	// 视频首帧就绪前保持透明，避免白屏里突然闪现
	const [playing, setPlaying] = useState(false);
	// 结束时的渐隐：淡出 500ms 后再卸载
	const [leaving, setLeaving] = useState(false);
	const closedRef = useRef(false);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const hideTimerRef = useRef<number | null>(null);

	useEffect(() => {
		// 移除 HTML 解析阶段注入的启动 loading，由本覆盖层接管
		document.getElementById("startup-splash-boot")?.remove();
		if (splashSeen()) {
			// 本次不播放：通知首页卡片动画不必等待覆盖层
			markSplashFinished();
			return;
		}
		// 开始播放即记为已看过：播放中途刷新也不会重播
		markSplashSeen();
		setVisible(true);
	}, []);

	const close = useCallback(() => {
		if (closedRef.current) {
			return;
		}
		closedRef.current = true;
		setLeaving(true);
		hideTimerRef.current = window.setTimeout(() => {
			setVisible(false);
			// 覆盖层已消失，首页卡片入场动画从这里起飞
			markSplashFinished();
		}, FADE_MS);
	}, []);

	useEffect(() => {
		if (!visible) {
			return;
		}
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			close();
			return;
		}
		const timer = window.setTimeout(close, LOAD_TIMEOUT_MS);
		// 自动播放被拦截（极少数策略）时同样放行页面
		videoRef.current?.play().catch(() => {
			close();
		});
		return () => {
			window.clearTimeout(timer);
			if (hideTimerRef.current !== null) {
				window.clearTimeout(hideTimerRef.current);
			}
		};
	}, [visible, close]);

	if (!visible) {
		return null;
	}

	return (
		<div
			className={
				leaving
					? "startup-splash startup-splash--leaving"
					: "startup-splash"
			}
			onClick={close}
			aria-hidden="true"
		>
			<video
				ref={videoRef}
				className={
					playing
						? "startup-splash__video startup-splash__video--playing"
						: "startup-splash__video"
				}
				src={normalizeImagePath(VIDEO_SRC)}
				autoPlay
				muted
				playsInline
				preload="auto"
				onPlaying={() => {
					setPlaying(true);
				}}
				onEnded={close}
				onError={close}
			/>
			<div
				className={
					playing
						? "startup-splash__loading startup-splash__loading--hidden"
						: "startup-splash__loading"
				}
				aria-hidden="true"
			>
				<span className="startup-splash__spinner" />
			</div>
		</div>
	);
}
