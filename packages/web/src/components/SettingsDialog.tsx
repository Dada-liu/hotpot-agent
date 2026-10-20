// 设置弹窗：左侧纵向 tab + 右侧内容区。
// 模型 tab 编辑 ~/.hotpot/settings.json 的 models 三档（provider/model/apiKey/baseUrl）
// 与主 agent 档位，保存走 PUT /api/settings（其余设置键服务端原样保留）。
// 打开时拉取最新配置，关闭即丢弃草稿；baseUrl 留空提交时省略该键。

import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	getModelSettings,
	type ModelRefWire,
	type ModelSettings,
	type ModelTier,
	updateModelSettings,
} from "../api.ts";

const TIER_ITEMS: { key: ModelTier; label: string }[] = [
	{ key: "high", label: "high 档" },
	{ key: "medium", label: "medium 档" },
	{ key: "low", label: "low 档" },
];

interface SettingsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: label 包裹的 children 即输入控件（隐式关联），规则无法穿透 children 属性和解
		<label className="flex flex-col gap-1 text-xs text-muted-foreground">
			{label}
			{children}
		</label>
	);
}

export function SettingsDialog({
	open,
	onOpenChange,
}: SettingsDialogProps): ReactElement {
	const [draft, setDraft] = useState<ModelSettings | null>(null);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// 打开时拉取最新设置；关闭由 Radix 卸载内容，草稿随状态留在本组件内但下次打开会重拉
	useEffect(() => {
		if (!open) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		getModelSettings()
			.then((settings) => {
				if (!cancelled) setDraft(settings);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const updateTier = (tier: ModelTier, patch: Partial<ModelRefWire>): void => {
		setDraft((prev) =>
			prev === null
				? prev
				: {
						...prev,
						models: {
							...prev.models,
							[tier]: { ...prev.models[tier], ...patch },
						},
					},
		);
	};

	const handleSave = async (): Promise<void> => {
		if (draft === null) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			// baseUrl 留空 → 省略该键（服务端 schema 要求 min(1)）
			const payload: ModelSettings = {
				models: Object.fromEntries(
					TIER_ITEMS.map(({ key }) => {
						const ref = draft.models[key];
						return [
							key,
							ref.baseUrl?.trim()
								? ref
								: {
										provider: ref.provider,
										model: ref.model,
										apiKey: ref.apiKey,
									},
						];
					}),
				) as ModelSettings["models"],
				...(draft.mainAgentTier === undefined
					? {}
					: { mainAgentTier: draft.mainAgentTier }),
			};
			await updateModelSettings(payload);
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[680px] gap-0 overflow-hidden p-0">
				<DialogHeader className="border-b px-5 py-4">
					<DialogTitle>设置</DialogTitle>
				</DialogHeader>
				<Tabs defaultValue="models" className="flex min-h-0">
					<TabsList className="h-auto w-36 shrink-0 flex-col items-stretch justify-start gap-1 rounded-none border-r bg-transparent p-3">
						<TabsTrigger
							value="models"
							className="justify-start data-[state=active]:bg-accent"
						>
							模型
						</TabsTrigger>
					</TabsList>
					<TabsContent
						value="models"
						className="max-h-[60vh] min-w-0 flex-1 overflow-y-auto p-5"
					>
						{loading ? (
							<div className="py-10 text-center text-sm text-muted-foreground">
								加载中…
							</div>
						) : draft === null ? (
							<div className="py-10 text-center text-sm text-destructive">
								{error ?? "加载失败"}
							</div>
						) : (
							<div className="flex flex-col gap-4">
								{TIER_ITEMS.map(({ key, label }) => {
									const ref = draft.models[key];
									return (
										<section key={key} className="rounded-xl border p-4">
											<div className="mb-3 text-sm font-medium">{label}</div>
											<div className="grid grid-cols-2 gap-3">
												<Field label="provider">
													<Input
														value={ref.provider}
														onChange={(e) => {
															updateTier(key, { provider: e.target.value });
														}}
													/>
												</Field>
												<Field label="model">
													<Input
														value={ref.model}
														onChange={(e) => {
															updateTier(key, { model: e.target.value });
														}}
													/>
												</Field>
												<Field label="apiKey（支持 $ENV 引用）">
													<Input
														value={ref.apiKey}
														onChange={(e) => {
															updateTier(key, { apiKey: e.target.value });
														}}
													/>
												</Field>
												<Field label="baseUrl（可选）">
													<Input
														value={ref.baseUrl ?? ""}
														placeholder="官方端点可留空"
														onChange={(e) => {
															updateTier(key, { baseUrl: e.target.value });
														}}
													/>
												</Field>
											</div>
										</section>
									);
								})}
								<Field label="主 agent 档位（新会话默认）">
									<select
										className="h-9 w-full rounded-md border border-border-strong bg-background px-2 text-sm"
										value={draft.mainAgentTier ?? "high"}
										onChange={(e) => {
											setDraft((prev) =>
												prev === null
													? prev
													: {
															...prev,
															mainAgentTier: e.target.value as ModelTier,
														},
											);
										}}
									>
										{TIER_ITEMS.map(({ key, label }) => (
											<option key={key} value={key}>
												{label}
											</option>
										))}
									</select>
								</Field>
							</div>
						)}
					</TabsContent>
				</Tabs>
				<DialogFooter className="border-t px-5 py-3">
					{error !== null && (
						<span className="mr-auto self-center text-sm text-destructive">
							{error}
						</span>
					)}
					<Button
						variant="outline"
						onClick={() => {
							onOpenChange(false);
						}}
					>
						取消
					</Button>
					<Button
						onClick={() => {
							void handleSave();
						}}
						disabled={saving || draft === null}
					>
						{saving ? "保存中…" : "保存"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
