// 设置弹窗：左侧纵向 tab + 右侧内容区，编辑 ~/.hotpot/settings.json 的全部用户级配置。
// 模型 tab 维护三档 models 与主 agent 档位；通用 tab 维护并行/修订上限与权限档位；
// 功能 tab 维护 features.* 开关与 compaction 预算；工具与目录 tab 维护 skills/prompts
// 目录与 webSearch 后端；高级 tab 以 JSON 编辑 hooks 与 mcpServers；遥测 tab 维护
// telemetry.*。保存走 PUT /api/settings（未知键服务端原样保留）；apiKey/token 为掩码
// 时值原样回传，服务端保留磁盘原值。打开时拉取最新配置，关闭即丢弃草稿。

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
import { Textarea } from "@/components/ui/textarea";
import {
	getSettings,
	type ModelRefWire,
	type ModelTier,
	type PermissionModeWire,
	type SettingsView,
	updateSettings,
} from "../api.ts";

const TIER_ITEMS: { key: ModelTier; label: string }[] = [
	{ key: "high", label: "high 档" },
	{ key: "medium", label: "medium 档" },
	{ key: "low", label: "low 档" },
];

const PERMISSION_ITEMS: { key: PermissionModeWire; label: string }[] = [
	{ key: "readonly", label: "只读" },
	{ key: "ask-on-dangerous", label: "危险操作询问" },
	{ key: "full", label: "完全权限" },
];

// features.* 开关展示序：默认全开，memory 为避免隐式增加 prompt token 默认关闭
const FEATURE_ITEMS: {
	key: keyof NonNullable<SettingsView["features"]>;
	label: string;
}[] = [
	{ key: "todo", label: "任务清单（todo 工具）" },
	{ key: "hooks", label: "钩子链（Claude Code 格式）" },
	{ key: "skills", label: "技能发现（SKILL.md）" },
	{ key: "promptTemplates", label: "Prompt 模板（/ 命令）" },
	{ key: "webSearch", label: "联网搜索工具" },
	{ key: "webFetch", label: "网页抓取工具" },
	{ key: "mcp", label: "MCP 接入" },
	{ key: "compaction", label: "上下文自动压缩" },
	{ key: "memory", label: "用户记忆（MEMORY.md）" },
];

const FEATURE_DEFAULT_OFF = new Set(["memory"]);

// 数字输入的草稿（字符串态，允许中间态；保存时解析校验）
interface NumericDrafts {
	maxParallelTasks: string;
	planMaxRevisions: string;
	triggerRatio: string;
	keepRecentTokens: string;
	flushIntervalMs: string;
}

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

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="rounded-xl border p-4">
			<div className="mb-3 text-sm font-medium">{title}</div>
			<div className="flex flex-col gap-3">{children}</div>
		</section>
	);
}

// 开关：语义色双态（开=bg-primary 黑底白钮，关=bg-accent 灰底），不写散色值
function Toggle({
	checked,
	onChange,
	label,
	hint,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	hint?: string;
}): ReactElement {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			onClick={() => {
				onChange(!checked);
			}}
			className="flex items-center justify-between gap-3 py-1 text-left"
		>
			<span className="flex min-w-0 flex-col">
				<span className="text-sm text-foreground">{label}</span>
				{hint !== undefined && (
					<span className="text-xs text-muted-foreground">{hint}</span>
				)}
			</span>
			<span
				className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-primary" : "bg-accent"}`}
			>
				<span
					className={`absolute top-0.5 size-4 rounded-full bg-background transition-all ${checked ? "left-4.5" : "left-0.5"}`}
				/>
			</span>
		</button>
	);
}

// JSON 草稿解析：空文本返回 undefined（不修改该键），非法 JSON 抛带字段名的错误
function parseJsonField(name: string, text: string): unknown {
	if (text.trim() === "") {
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${name} 不是合法 JSON`);
	}
}

// 解析正整数/正数字段，缺省回退默认值；非法输入抛错
function parseNumberField(
	name: string,
	text: string,
	fallback: number,
	integer: boolean,
): number {
	if (text.trim() === "") {
		return fallback;
	}
	const value = Number(text);
	if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
		throw new Error(`${name} 需为${integer ? "正整数" : "数字"}`);
	}
	return value;
}

export function SettingsDialog({
	open,
	onOpenChange,
}: SettingsDialogProps): ReactElement {
	const [draft, setDraft] = useState<SettingsView | null>(null);
	const [numeric, setNumeric] = useState<NumericDrafts | null>(null);
	// hooks/mcpServers/webSearch.headers 的 JSON 草稿（空 = 不修改该键）
	const [hooksText, setHooksText] = useState("");
	const [mcpText, setMcpText] = useState("");
	const [headersText, setHeadersText] = useState("");
	const [permissionMode, setPermissionMode] =
		useState<PermissionModeWire>("ask-on-dangerous");
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
		getSettings()
			.then((settings) => {
				if (cancelled) return;
				setDraft(settings);
				setNumeric({
					maxParallelTasks: String(settings.maxParallelTasks ?? 10),
					planMaxRevisions: String(settings.planMaxRevisions ?? 3),
					triggerRatio: String(settings.compaction?.triggerRatio ?? 0.8),
					keepRecentTokens: String(
						settings.compaction?.keepRecentTokens ?? 20000,
					),
					flushIntervalMs: String(settings.telemetry?.flushIntervalMs ?? 30000),
				});
				setHooksText(
					settings.hooks === undefined
						? ""
						: JSON.stringify(settings.hooks, null, 2),
				);
				setMcpText(
					settings.mcpServers === undefined
						? ""
						: JSON.stringify(settings.mcpServers, null, 2),
				);
				setHeadersText(
					settings.webSearch?.headers === undefined
						? ""
						: JSON.stringify(settings.webSearch.headers, null, 2),
				);
				setPermissionMode(settings.permission?.mode ?? "ask-on-dangerous");
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

	const updateFeature = (
		key: keyof NonNullable<SettingsView["features"]>,
		enabled: boolean,
	): void => {
		setDraft((prev) =>
			prev === null
				? prev
				: { ...prev, features: { ...prev.features, [key]: enabled } },
		);
	};

	const handleSave = async (): Promise<void> => {
		if (draft === null || numeric === null) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const maxParallelTasks = parseNumberField(
				"并行 task 上限",
				numeric.maxParallelTasks,
				10,
				true,
			);
			const planMaxRevisions = parseNumberField(
				"plan 最大修订轮数",
				numeric.planMaxRevisions,
				3,
				true,
			);
			const triggerRatio = parseNumberField(
				"压缩触发比例",
				numeric.triggerRatio,
				0.8,
				false,
			);
			const keepRecentTokens = parseNumberField(
				"压缩保留预算",
				numeric.keepRecentTokens,
				20000,
				true,
			);
			const flushIntervalMs = parseNumberField(
				"遥测 flush 间隔",
				numeric.flushIntervalMs,
				30000,
				true,
			);
			const hooks = parseJsonField("hooks", hooksText);
			const mcpServers = parseJsonField("mcpServers", mcpText);
			const headers = parseJsonField("webSearch headers", headersText);

			// baseUrl 留空 → 省略该键（服务端 schema 要求 min(1)）
			const models = Object.fromEntries(
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
			) as SettingsView["models"];

			const features = Object.fromEntries(
				FEATURE_ITEMS.map(({ key }) => [
					key,
					draft.features?.[key] ?? !FEATURE_DEFAULT_OFF.has(key),
				]),
			) as NonNullable<SettingsView["features"]>;

			const webSearchBackend = draft.webSearch?.backend;
			const payload: SettingsView = {
				models,
				mainAgentTier: draft.mainAgentTier ?? "high",
				maxParallelTasks,
				planMaxRevisions,
				permission: { mode: permissionMode },
				features,
				compaction: { triggerRatio, keepRecentTokens },
				...(hooks === undefined ? {} : { hooks }),
				...(mcpServers === undefined
					? {}
					: { mcpServers: mcpServers as Record<string, unknown> }),
				skillsDirs: (draft.skillsDirs ?? []).filter((d) => d.trim() !== ""),
				promptsDirs: (draft.promptsDirs ?? []).filter((d) => d.trim() !== ""),
				...(webSearchBackend === undefined
					? {}
					: {
							webSearch: {
								backend: webSearchBackend,
								// 掩码或留空都原样省略键，服务端保留磁盘值
								...(draft.webSearch?.apiKey?.trim() &&
								draft.webSearch.apiKey !== "********"
									? { apiKey: draft.webSearch.apiKey }
									: {}),
								...(draft.webSearch?.baseUrl?.trim()
									? { baseUrl: draft.webSearch.baseUrl }
									: {}),
								...(headers === undefined
									? {}
									: { headers: headers as Record<string, string> }),
							},
						}),
				telemetry: {
					enabled: draft.telemetry?.enabled ?? true,
					endpoint: draft.telemetry?.endpoint ?? "",
					...(draft.telemetry?.token?.trim() &&
					draft.telemetry.token !== "********"
						? { token: draft.telemetry.token }
						: {}),
					flushIntervalMs,
				},
			};
			await updateSettings(payload);
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
						<TabsTrigger
							value="general"
							className="justify-start data-[state=active]:bg-accent"
						>
							通用
						</TabsTrigger>
						<TabsTrigger
							value="features"
							className="justify-start data-[state=active]:bg-accent"
						>
							功能
						</TabsTrigger>
						<TabsTrigger
							value="tools"
							className="justify-start data-[state=active]:bg-accent"
						>
							工具与目录
						</TabsTrigger>
						<TabsTrigger
							value="advanced"
							className="justify-start data-[state=active]:bg-accent"
						>
							高级
						</TabsTrigger>
						<TabsTrigger
							value="telemetry"
							className="justify-start data-[state=active]:bg-accent"
						>
							遥测
						</TabsTrigger>
					</TabsList>
					{loading ? (
						<div className="max-h-[60vh] flex-1 px-5 py-10 text-center text-sm text-muted-foreground">
							加载中…
						</div>
					) : draft === null || numeric === null ? (
						<div className="max-h-[60vh] flex-1 px-5 py-10 text-center text-sm text-destructive">
							{error ?? "加载失败"}
						</div>
					) : (
						<>
							<TabsContent
								value="models"
								className="max-h-[60vh] min-w-0 flex-1 overflow-y-auto p-5"
							>
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
																updateTier(key, {
																	provider: e.target.value,
																});
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
																updateTier(key, {
																	baseUrl: e.target.value,
																});
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
							</TabsContent>
							<TabsContent
								value="general"
								className="max-h-[60vh] min-w-0 flex-1 overflow-y-auto p-5"
							>
								<div className="flex flex-col gap-4">
									<Section title="编排">
										<Field label="worker 并行 task 上限（默认 10）">
											<Input
												type="number"
												min={1}
												value={numeric.maxParallelTasks}
												onChange={(e) => {
													setNumeric({
														...numeric,
														maxParallelTasks: e.target.value,
													});
												}}
											/>
										</Field>
										<Field label="plan 被批注后的最大修订轮数（默认 3）">
											<Input
												type="number"
												min={1}
												value={numeric.planMaxRevisions}
												onChange={(e) => {
													setNumeric({
														...numeric,
														planMaxRevisions: e.target.value,
													});
												}}
											/>
										</Field>
									</Section>
									<Section title="权限">
										<Field label="权限档位（仅用户级，项目级无法覆盖）">
											<select
												className="h-9 w-full rounded-md border border-border-strong bg-background px-2 text-sm"
												value={permissionMode}
												onChange={(e) => {
													setPermissionMode(
														e.target.value as PermissionModeWire,
													);
												}}
											>
												{PERMISSION_ITEMS.map(({ key, label }) => (
													<option key={key} value={key}>
														{label}
													</option>
												))}
											</select>
										</Field>
									</Section>
								</div>
							</TabsContent>
							<TabsContent
								value="features"
								className="max-h-[60vh] min-w-0 flex-1 overflow-y-auto p-5"
							>
								<div className="flex flex-col gap-4">
									<Section title="功能开关">
										{FEATURE_ITEMS.map(({ key, label }) => (
											<Toggle
												key={key}
												label={label}
												checked={
													draft.features?.[key] ?? !FEATURE_DEFAULT_OFF.has(key)
												}
												onChange={(checked) => {
													updateFeature(key, checked);
												}}
											/>
										))}
									</Section>
									<Section title="上下文自动压缩（用户级）">
										<Field label="触发比例 triggerRatio（默认 0.8，范围 (0,1]）">
											<Input
												type="number"
												min={0.05}
												max={1}
												step={0.05}
												value={numeric.triggerRatio}
												onChange={(e) => {
													setNumeric({
														...numeric,
														triggerRatio: e.target.value,
													});
												}}
											/>
										</Field>
										<Field label="保留最近历史预算 keepRecentTokens（默认 20000）">
											<Input
												type="number"
												min={1}
												value={numeric.keepRecentTokens}
												onChange={(e) => {
													setNumeric({
														...numeric,
														keepRecentTokens: e.target.value,
													});
												}}
											/>
										</Field>
									</Section>
								</div>
							</TabsContent>
							<TabsContent
								value="tools"
								className="max-h-[60vh] min-w-0 flex-1 overflow-y-auto p-5"
							>
								<div className="flex flex-col gap-4">
									<Section title="webSearch 后端">
										<Field label="backend">
											<select
												className="h-9 w-full rounded-md border border-border-strong bg-background px-2 text-sm"
												value={draft.webSearch?.backend ?? ""}
												onChange={(e) => {
													const backend = e.target.value;
													setDraft((prev) =>
														prev === null
															? prev
															: {
																	...prev,
																	webSearch:
																		backend === ""
																			? undefined
																			: {
																					...prev.webSearch,
																					backend: backend as
																						| "duckduckgo"
																						| "custom",
																				},
																},
													);
												}}
											>
												<option value="">未配置</option>
												<option value="duckduckgo">
													duckduckgo（无需 key）
												</option>
												<option value="custom">
													custom（baseUrl + 可选凭证）
												</option>
											</select>
										</Field>
										{draft.webSearch?.backend === "custom" && (
											<>
												<Field label="apiKey（可选，掩码保留原值）">
													<Input
														value={draft.webSearch.apiKey ?? ""}
														onChange={(e) => {
															setDraft((prev) =>
																prev === null
																	? prev
																	: {
																			...prev,
																			webSearch: {
																				...prev.webSearch,
																				backend: "custom",
																				apiKey: e.target.value,
																			},
																		},
															);
														}}
													/>
												</Field>
												<Field label="baseUrl">
													<Input
														value={draft.webSearch.baseUrl ?? ""}
														onChange={(e) => {
															setDraft((prev) =>
																prev === null
																	? prev
																	: {
																			...prev,
																			webSearch: {
																				...prev.webSearch,
																				backend: "custom",
																				baseUrl: e.target.value,
																			},
																		},
															);
														}}
													/>
												</Field>
												<Field label="headers（JSON，留空不修改）">
													<Textarea
														className="font-mono text-xs"
														rows={3}
														placeholder='{"X-Key":"..."}'
														value={headersText}
														onChange={(e) => {
															setHeadersText(e.target.value);
														}}
													/>
												</Field>
											</>
										)}
									</Section>
									<Section title="目录">
										<Field label="skillsDirs（技能扫描目录，每行一个）">
											<Textarea
												className="font-mono text-xs"
												rows={3}
												value={(draft.skillsDirs ?? []).join("\n")}
												onChange={(e) => {
													const dirs = e.target.value
														.split("\n")
														.map((d) => d.trim());
													setDraft((prev) =>
														prev === null
															? prev
															: { ...prev, skillsDirs: dirs },
													);
												}}
											/>
										</Field>
										<Field label="promptsDirs（prompt 模板目录，每行一个）">
											<Textarea
												className="font-mono text-xs"
												rows={3}
												value={(draft.promptsDirs ?? []).join("\n")}
												onChange={(e) => {
													const dirs = e.target.value
														.split("\n")
														.map((d) => d.trim());
													setDraft((prev) =>
														prev === null
															? prev
															: { ...prev, promptsDirs: dirs },
													);
												}}
											/>
										</Field>
									</Section>
								</div>
							</TabsContent>
							<TabsContent
								value="advanced"
								className="max-h-[60vh] min-w-0 flex-1 overflow-y-auto p-5"
							>
								<div className="flex flex-col gap-4">
									<Section title="hooks（Claude Code 配置形状）">
										<Textarea
											className="font-mono text-xs"
											rows={8}
											placeholder='{"SessionStart":[...],"PreToolUse":[...],"PostToolUse":[...],"Stop":[...]}&#10;留空 = 不修改；填 {} 清空'
											value={hooksText}
											onChange={(e) => {
												setHooksText(e.target.value);
											}}
										/>
									</Section>
									<Section title="mcpServers">
										<Textarea
											className="font-mono text-xs"
											rows={8}
											placeholder='{"fs":{"command":"mcp-fs"},"remote":{"url":"https://..."}}&#10;留空 = 不修改；填 {} 清空'
											value={mcpText}
											onChange={(e) => {
												setMcpText(e.target.value);
											}}
										/>
									</Section>
								</div>
							</TabsContent>
							<TabsContent
								value="telemetry"
								className="max-h-[60vh] min-w-0 flex-1 overflow-y-auto p-5"
							>
								<div className="flex flex-col gap-4">
									<Section title="遥测（匿名，旁路上报）">
										<Toggle
											label="启用遥测"
											hint="关闭后始终不上报；事件白名单见文档"
											checked={draft.telemetry?.enabled ?? true}
											onChange={(checked) => {
												setDraft((prev) =>
													prev === null
														? prev
														: {
																...prev,
																telemetry: {
																	...prev.telemetry,
																	enabled: checked,
																},
															},
												);
											}}
										/>
										<Field label="endpoint（留空回退到环境变量/内置地址）">
											<Input
												value={draft.telemetry?.endpoint ?? ""}
												onChange={(e) => {
													setDraft((prev) =>
														prev === null
															? prev
															: {
																	...prev,
																	telemetry: {
																		...prev.telemetry,
																		endpoint: e.target.value,
																	},
																},
													);
												}}
											/>
										</Field>
										<Field label="token（可选，掩码保留原值）">
											<Input
												value={draft.telemetry?.token ?? ""}
												onChange={(e) => {
													setDraft((prev) =>
														prev === null
															? prev
															: {
																	...prev,
																	telemetry: {
																		...prev.telemetry,
																		token: e.target.value,
																	},
																},
													);
												}}
											/>
										</Field>
										<Field label="flushIntervalMs（默认 30000；0 = 只靠阈值与 close）">
											<Input
												type="number"
												min={0}
												value={numeric.flushIntervalMs}
												onChange={(e) => {
													setNumeric({
														...numeric,
														flushIntervalMs: e.target.value,
													});
												}}
											/>
										</Field>
									</Section>
								</div>
							</TabsContent>
						</>
					)}
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
						disabled={saving || draft === null || loading}
					>
						{saving ? "保存中…" : "保存"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
