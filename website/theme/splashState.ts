// 开场动画结束信号：首页卡片入场动画需要等覆盖层真正消失后再起飞。
// 用模块内状态而不是 DOM 查询，避免依赖 Layout 与页面组件 effect 的执行顺序。

type Listener = () => void;

let finished = false;
const listeners = new Set<Listener>();

export function markSplashFinished(): void {
	if (finished) {
		return;
	}
	finished = true;
	for (const listener of listeners) {
		listener();
	}
	listeners.clear();
}

export function isSplashFinished(): boolean {
	return finished;
}

export function onSplashFinished(listener: Listener): () => void {
	if (finished) {
		listener();
		return () => {};
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
