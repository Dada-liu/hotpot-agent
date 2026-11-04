// 官网启动动画：永久只播放一次（localStorage 记录），后续访问不再显示 loading 与动画。
// 严格顺序：页面 loading → 视频首帧就绪后播放 → 播完渐隐 → 首页卡片区滚动 → 卡片飞入。
// 覆盖层消失前不会触发滚动，避免视频还没加载完页面就开始滚动。
// 视频在 HTML 解析阶段通过 rspress.config.ts 的 head 预加载（已看过则不再预加载）；
// 首帧就绪前在页面中间显示橙色三点 loading。

import { normalizeImagePath } from "@rspress/core/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { introSeen, markIntroSeen } from "./introStorage";
import { markSplashFinished } from "./splashState";

const VIDEO_SRC = "/video/startMV_alpha_282.webm";
// 兜底：视频迟迟加载不出来时不永久遮挡页面
const LOAD_TIMEOUT_MS = 30000;
// 结束渐隐时长
const FADE_MS = 500;

export function StartupSplash() {
	// 首帧与 SSR 都不渲染，等客户端挂载后再展示，避免 hydration 不一致
	const [visible, setVisible] = useState(false);
	// 视频首帧就绪前保持透明，避免白屏里突然闪现
	const [playing, setPlaying] = useState(false);
	// 结束时的渐隐：淡出 500ms 后再卸载
	const [leaving, setLeaving] = useState(false);
	const closedRef = useRef(false);
	// 视频是否真正播放过：只有播放过才把开场序列记为已展示
	const playedRef = useRef(false);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const hideTimerRef = useRef<number | null>(null);

	useEffect(() => {
		// 移除 HTML 解析阶段注入的启动 loading，由本覆盖层接管
		document.getElementById("startup-splash-boot")?.remove();
		if (introSeen()) {
			// 已永久看过：本次只展示 loading，不再播放动画
			markSplashFinished();
			return;
		}
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
			// 视频正常播放过才算完成一次开场序列；加载失败等兜底路径下次仍会重试
			if (playedRef.current) {
				markIntroSeen();
			}
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
					playedRef.current = true;
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
