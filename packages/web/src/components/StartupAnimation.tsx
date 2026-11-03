// 启动动画：打开 web 时全屏播放透明背景 WebM（黑/橙图形，白底与页面一致），
// 播完或点击任意处后直接卸载覆盖层，由 App 把界面 500ms 渐显出来。
// 视频加载失败、自动播放被拦截或用户偏好减少动效时同样立即放行。

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const VIDEO_SRC = "/video/startMV_alpha_282.webm";
// 视频迟迟加载不出来时不遮挡界面
const LOAD_TIMEOUT_MS = 15000;
// 结束渐隐时长（与 App 根布局的渐显时长一致）
const FADE_MS = 500;
// 每个标签页会话只播一次：刷新不重播，新开标签页仍算首次进入
const SPLASH_SEEN_KEY = "hotpot.splashSeen";

// storage 不可用（隐私模式等）时视为已看过，避免每次加载都弹
export function startupSplashSeen(): boolean {
	try {
		return sessionStorage.getItem(SPLASH_SEEN_KEY) === "1";
	} catch {
		return true;
	}
}

function markStartupSplashSeen(): void {
	try {
		sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
	} catch {
		// 忽略：下次加载会再次展示
	}
}

interface StartupAnimationProps {
	// 覆盖层卸载后通知 App 开始渐显界面
	onDone: () => void;
}

export function StartupAnimation({ onDone }: StartupAnimationProps) {
	// 已看过时直接不渲染；App 用同一判断决定首屏是否隐藏，避免多余的渐显
	const [mounted, setMounted] = useState(() => !startupSplashSeen());
	// 视频首帧就绪前保持透明，避免白屏里突然闪现
	const [playing, setPlaying] = useState(false);
	// 结束时的渐隐：覆盖层淡出与界面渐显同时进行，500ms 后再卸载
	const [leaving, setLeaving] = useState(false);
	const exitedRef = useRef(false);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const hideTimerRef = useRef<number | null>(null);

	const dismiss = useCallback(() => {
		if (exitedRef.current) {
			return;
		}
		exitedRef.current = true;
		setLeaving(true);
		// 通知 App 同时开始渐显，形成交叉过渡
		onDone();
		hideTimerRef.current = window.setTimeout(() => {
			setMounted(false);
		}, FADE_MS);
	}, [onDone]);

	useEffect(() => {
		if (!mounted) {
			return;
		}
		// 开始播放即记为已看过：播放中途刷新也不会重播
		markStartupSplashSeen();
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			dismiss();
			return;
		}
		const timer = window.setTimeout(dismiss, LOAD_TIMEOUT_MS);
		// 自动播放被拦截（极少数策略）时同样放行界面
		videoRef.current?.play().catch(() => {
			dismiss();
		});
		return () => {
			window.clearTimeout(timer);
			if (hideTimerRef.current !== null) {
				window.clearTimeout(hideTimerRef.current);
			}
		};
	}, [mounted, dismiss]);

	if (!mounted) {
		return null;
	}

	return (
		<div
			className={cn(
				"fixed inset-0 z-50 flex items-center justify-center bg-background transition-opacity duration-500 motion-reduce:transition-none",
				leaving ? "pointer-events-none opacity-0" : "opacity-100",
			)}
			onClick={dismiss}
			aria-hidden="true"
		>
			<video
				ref={videoRef}
				src={VIDEO_SRC}
				autoPlay
				muted
				playsInline
				preload="auto"
				onPlaying={() => {
					setPlaying(true);
				}}
				onEnded={dismiss}
				onError={dismiss}
				className={cn(
					"w-[min(92vw,1080px)] transition-opacity duration-300",
					playing ? "opacity-100" : "opacity-0",
				)}
			/>
		</div>
	);
}
