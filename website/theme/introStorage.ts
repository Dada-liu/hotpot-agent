// 开场动画序列（开场视频 → 滚动到卡片区 → 卡片飞入）永久只展示一次。
// 用 localStorage 记录；读写失败时退化为每次展示，不影响页面加载。

export const INTRO_SEEN_KEY = "hotpot.introSeen";

export function introSeen(): boolean {
	try {
		return localStorage.getItem(INTRO_SEEN_KEY) === "1";
	} catch {
		// storage 不可用时视为未看过，动画照常播放
		return false;
	}
}

export function markIntroSeen(): void {
	try {
		localStorage.setItem(INTRO_SEEN_KEY, "1");
	} catch {
		// 忽略：下次访问会再次展示
	}
}
