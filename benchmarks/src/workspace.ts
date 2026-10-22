// WorkspaceProvider 是 benchmark 与「代码放在哪」之间的唯一缝：
// M5 用 CheckoutWorkspaceProvider（普通 git worktree，不装依赖），
// 以后可换成 ContainerWorkspaceProvider（容器内 checkout），上层 runner 不用改。
// 只约定 prepare/cleanup 与 cwd，不暴露 clone 细节。

export interface WorkspaceInstance {
	instance_id: string;
	repo: string;
	base_commit: string;
}

export interface Workspace {
	cwd: string;
	cleanup(): Promise<void>;
}

export interface WorkspaceProvider {
	prepare(instance: WorkspaceInstance): Promise<Workspace>;
}
