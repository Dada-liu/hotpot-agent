// 左栏：Kimi 风窄边栏（logo + 新建会话大卡 + 会话列表 + 底部功能按钮区）。
// 新建（cwd 可留空走服务端默认）、切换、创建时间展示；会话名超长由 CSS 省略号打点，
// 打点才经 tooltip 展示全称，未截断不出；行尾下拉（hover 露出、展开时 ChevronDown 旋转，向左弹出）承载会话操作：
// 运行中只显示归档（结束回合并落盘，二次确认），空闲显示删除（二次确认）。
// 底部功能按钮区：设置（弹设置弹窗，见 SettingsDialog）。

import { Archive, ChevronDown, Plus, Settings, Trash2 } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "../api.ts";

function formatTime(iso: string): string {
	const t = new Date(iso);
	return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
}

interface SessionRowProps {
	session: SessionSummary;
	active: boolean;
	name: string;
	onSelect: (id: string) => void;
	onDelete: (id: string) => void;
	onArchive: (id: string) => void;
}

// 单行 = 会话主体（点击选中）+ 行尾展开/收起下拉（hover 露出、向左弹出）
function SessionRow({
	session,
	active,
	name,
	onSelect,
	onDelete,
	onArchive,
}: SessionRowProps): ReactElement {
	// 操作二次确认：首次点菜单项进入确认态（菜单保持打开），再点一次才执行；
	// 菜单关闭即重置（DropdownMenuContent 卸载，confirming 随之复位）
	const [confirming, setConfirming] = useState(false);
	const running = session.turn === "running";

	// 会话名是否被省略号截断（打点）：span 挂载或换名（key 变化触发重挂）时量一次 scrollWidth，
	// 全名展示时 hover 不出 tooltip，只有打点才挂 Tooltip 展示全称
	const [truncated, setTruncated] = useState(false);
	const measureName = useCallback((el: HTMLSpanElement | null) => {
		if (el !== null) {
			setTruncated(el.scrollWidth > el.clientWidth);
		}
	}, []);
	const nameSpan = (
		<span ref={measureName} key={name} className="block truncate text-sm">
			{name}
		</span>
	);

	return (
		<li className="group flex items-center">
			<button
				type="button"
				className={cn(
					"min-w-0 flex-1 rounded-lg px-2 py-2 text-left transition-colors",
					active ? "bg-primary text-primary-foreground" : "hover:bg-accent",
				)}
				onClick={() => {
					onSelect(session.id);
				}}
			>
				{truncated ? (
					<Tooltip>
						<TooltipTrigger asChild>{nameSpan}</TooltipTrigger>
						<TooltipContent side="right">{name}</TooltipContent>
					</Tooltip>
				) : (
					nameSpan
				)}
				<span
					className={cn(
						"mt-0.5 flex items-center gap-1.5 text-[11px]",
						active ? "text-primary-foreground/60" : "text-muted-foreground",
					)}
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							session.turn === "running" ? "bg-brand" : "bg-current opacity-40",
						)}
					/>
					{formatTime(session.createdAt)}
				</span>
			</button>
			<DropdownMenu
				onOpenChange={(open) => {
					if (!open) {
						setConfirming(false);
					}
				}}
			>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						aria-label="会话操作"
						className={cn(
							"flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
							active
								? "text-primary-foreground/70 hover:text-primary-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<ChevronDown className="size-3.5 transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="left" align="start" sideOffset={4}>
					{running ? (
						<DropdownMenuItem
							className="gap-2"
							onSelect={(e) => {
								if (!confirming) {
									// 首次点击：拦截默认的选单即关行为，停留在确认态
									e.preventDefault();
									setConfirming(true);
									return;
								}
								onArchive(session.id);
							}}
						>
							<Archive className="size-3.5" />
							{confirming ? "再次点击确认归档" : "归档"}
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem
							variant="destructive"
							className="gap-2"
							onSelect={(e) => {
								if (!confirming) {
									e.preventDefault();
									setConfirming(true);
									return;
								}
								onDelete(session.id);
							}}
						>
							<Trash2 className="size-3.5" />
							{confirming ? "再次点击确认删除" : "删除会话"}
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}

interface SessionListProps {
	sessions: SessionSummary[];
	currentId: string | null;
	nameFor: (s: SessionSummary) => string;
	onSelect: (id: string) => void;
	onCreate: () => void;
	onDelete: (id: string) => void;
	onArchive: (id: string) => void;
	onOpenSettings: () => void;
}

export function SessionList({
	sessions,
	currentId,
	nameFor,
	onSelect,
	onCreate,
	onDelete,
	onArchive,
	onOpenSettings,
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
					className="w-full justify-start gap-2 rounded-xl border-border-strong bg-background py-5 hover:bg-accent"
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
					{sessions.map((s) => (
						<SessionRow
							key={s.id}
							session={s}
							active={s.id === currentId}
							name={nameFor(s)}
							onSelect={onSelect}
							onDelete={onDelete}
							onArchive={onArchive}
						/>
					))}
					{sessions.length === 0 && (
						<li className="px-3 py-6 text-center text-xs text-muted-foreground">
							暂无会话，点上方「新建会话」开始
						</li>
					)}
				</ul>
			</ScrollArea>
			<div className="border-t p-2">
				<Button
					variant="outline"
					className="w-full justify-start gap-2 rounded-xl border-border-strong bg-background py-5 hover:bg-accent"
					onClick={onOpenSettings}
				>
					<Settings className="size-4" />
					设置
				</Button>
			</div>
		</aside>
	);
}
