// 左栏：会话列表。新建（cwd 可留空走服务端默认）、切换、创建时间与 cwd 截断展示。

import type { ReactElement } from "react";
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
		<aside className="session-list">
			<div className="session-list-header">
				<span>会话</span>
				<button type="button" className="btn" onClick={onCreate}>
					+ 新建
				</button>
			</div>
			<ul>
				{sessions.map((s) => (
					<li key={s.id}>
						<button
							type="button"
							className={
								s.id === currentId
									? "session-item session-item-active"
									: "session-item"
							}
							onClick={() => {
								onSelect(s.id);
							}}
						>
							<span className="session-item-cwd" title={s.cwd}>
								{truncate(s.cwd, 28)}
							</span>
							<span className="session-item-meta">
								<span
									className={
										s.turn === "running"
											? "turn-dot turn-dot-running"
											: "turn-dot"
									}
								/>
								{formatTime(s.createdAt)}
							</span>
						</button>
					</li>
				))}
				{sessions.length === 0 && (
					<li className="session-list-empty">暂无会话，点击「+ 新建」开始</li>
				)}
			</ul>
		</aside>
	);
}
