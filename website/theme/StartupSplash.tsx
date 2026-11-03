// 官网启动动画：首次进入站点时全屏播放透明背景 WebM（白底 + 黑/橙图形），
// 播完或点击任意处后直接卸载覆盖层；用 sessionStorage 记住，后续刷新不再展示。
// 新开标签页算一次新的访问，会重新播放。

import { normalizeImagePath } from "@rspress/core/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

const VIDEO_SRC = "/video/startMV_alpha_282.webm";
// 视频迟迟加载不出来时不遮挡页面
const LOAD_TIMEOUT_MS = 15000;
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
	const closedRef = useRef(false);
	const videoRef = useRef<HTMLVideoElement | null>(null);

	useEffect(() => {
		if (splashSeen()) {
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
		setVisible(false);
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
		};
	}, [visible, close]);

	if (!visible) {
		return null;
	}

	return (
		<div className="startup-splash" onClick={close} aria-hidden="true">
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
		</div>
	);
}
