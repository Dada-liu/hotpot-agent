// 左栏：Kimi 风窄边栏（logo + 新建会话大卡 + 会话列表）。
// 新建（cwd 可留空走服务端默认）、切换、创建时间与 cwd 截断展示；激活项黑底白字。

import { Plus } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "../api.ts";

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatTime(iso: string): string {
	const t = new Date(iso);
	return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
}

interface SessionListProps {
	sessions: SessionSummary[];
	currentId: string | null;
	onSelect: (id: string) => void;
	onCreate: () => void;
}

export function SessionList({
	sessions,
	currentId,
	onSelect,
	onCreate,
}: SessionListProps): ReactElement {
	return (
		<aside className="flex h-full w-60 shrink-0 flex-col border-r bg-secondary/60">
			<div className="flex items-center gap-2 px-4 pb-1 pt-4">
				<img
					src="/logo.png"
					alt="hotpot"
					className="h-8 w-8 rounded-lg object-contain"
				/>
				<span className="text-base font-semibold tracking-tight">hotpot</span>
			</div>
			<div className="px-3 pb-2 pt-3">
				<Button
					variant="outline"
					className="w-full justify-start gap-2 rounded-xl border bg-background py-5 shadow-sm hover:bg-accent"
					onClick={onCreate}
				>
					<Plus className="size-4" />
					新建会话
				</Button>
			</div>
			<div className="px-4 pb-1 pt-2 text-xs font-medium text-muted-foreground">
				会话
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<ul className="flex flex-col gap-0.5 px-2 pb-3">
					{sessions.map((s) => {
						const active = s.id === currentId;
						return (
							<li key={s.id}>
								<button
									type="button"
									className={cn(
										"w-full rounded-lg px-3 py-2 text-left transition-colors",
										active
											? "bg-primary text-primary-foreground"
											: "hover:bg-accent",
									)}
									onClick={() => {
										onSelect(s.id);
									}}
								>
									<span className="block truncate text-sm" title={s.cwd}>
										{truncate(s.cwd, 26)}
									</span>
									<span
										className={cn(
											"mt-0.5 flex items-center gap-1.5 text-[11px]",
											active
												? "text-primary-foreground/60"
												: "text-muted-foreground",
										)}
									>
										<span
											className={cn(
												"size-1.5 rounded-full",
												s.turn === "running"
													? "bg-brand"
													: "bg-current opacity-40",
											)}
										/>
										{formatTime(s.createdAt)}
									</span>
								</button>
							</li>
						);
					})}
					{sessions.length === 0 && (
						<li className="px-3 py-6 text-center text-xs text-muted-foreground">
							暂无会话，点上方「新建会话」开始
						</li>
					)}
				</ul>
			</ScrollArea>
		</aside>
	);
}
