// 工具调用卡片：图标 + 名称 + 入参摘要（JSON 截断 200 字符）+ 输出可展开 + isError 橙标。

import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function summarize(input: unknown): string {
	if (input === undefined) {
		return "";
	}
	let text: string;
	try {
		text = JSON.stringify(input) ?? "";
	} catch {
		return String(input);
	}
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

interface ToolCallCardProps {
	name: string;
	input: unknown;
	result?: { content: string; isError: boolean };
}

export function ToolCallCard({
	name,
	input,
	result,
}: ToolCallCardProps): ReactElement {
	const [expanded, setExpanded] = useState(false);
	const summary = summarize(input);
	const failed = result?.isError === true;
	return (
		<Card
			className={cn("gap-2 rounded-xl p-3", failed && "border-destructive/50")}
		>
			<div className="flex items-center gap-2">
				<Wrench className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="font-mono text-sm font-medium">{name}</span>
				{result !== undefined && (
					<Badge
						variant={failed ? "destructive" : "secondary"}
						className="ml-auto text-[11px]"
					>
						{failed ? "error" : "done"}
					</Badge>
				)}
			</div>
			{summary !== "" && (
				<pre className="overflow-x-auto rounded-md bg-secondary p-2 font-mono text-xs text-muted-foreground">
					{summary}
				</pre>
			)}
			{result !== undefined && (
				<div>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 gap-1 px-2 text-xs text-muted-foreground"
						onClick={() => {
							setExpanded((v) => !v);
						}}
					>
						{expanded ? (
							<ChevronDown className="size-3" />
						) : (
							<ChevronRight className="size-3" />
						)}
						{expanded ? "收起输出" : "展开输出"}
					</Button>
					{expanded && (
						<pre className="mt-1 max-h-72 overflow-auto rounded-md bg-secondary p-2 font-mono text-xs">
							{result.content}
						</pre>
					)}
				</div>
			)}
		</Card>
	);
}
