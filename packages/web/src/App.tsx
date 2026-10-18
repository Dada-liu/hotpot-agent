// 根组件：三栏布局（会话列表 | 对话 | agent 面板）与全局状态。
// 全局状态 = useReducer(chatReducer) 折叠 WireEvent 流；切换会话时重置并重建 SSE 连接。

import { useCallback, useEffect, useReducer, useState } from "react";
import {
	answerApproval,
	answerPlan,
	cancelTurn,
	createSession,
	listSessions,
	type SessionSummary,
	sendMessage,
	steerMessage,
} from "./api.ts";
import { AgentPanel } from "./components/AgentPanel.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { type ConnectionState, connect } from "./events.ts";
import type { WireEvent } from "./protocol.ts";
import { type ChatState, createInitialState, reduce } from "./state/reducer.ts";

// reducer 动作：事件折叠或会话切换时重置
type ChatAction = { type: "event"; event: WireEvent } | { type: "reset" };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
	if (action.type === "reset") {
		return createInitialState();
	}
	return reduce(state, action.event);
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// main agent 档位徽标的数据源：服务端按 settings.mainAgentTier 解析（缺省 "high"），
// 浏览器读不到该配置；非 web 创建（CLI 等）的会话同样无从得知——统一回退 "high"，
// 经 props 传给 AgentPanel（web 创建会话开放档位选择后由创建流程替换）
const MAIN_TIER_FALLBACK = "high";

export function App() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [currentId, setCurrentId] = useState<string | null>(null);
	const [chat, dispatch] = useReducer(
		chatReducer,
		undefined,
		createInitialState,
	);
	const [connState, setConnState] = useState<ConnectionState | "idle">("idle");
	const [error, setError] = useState<string | null>(null);
	// 面板收起是本地偏好：reducer 的 panelOpen 只负责首个 spawn 时自动展开
	const [panelCollapsed, setPanelCollapsed] = useState(false);

	const refreshSessions = useCallback(async () => {
		try {
			setSessions(await listSessions());
		} catch (e) {
			setError(errorMessage(e));
		}
	}, []);

	useEffect(() => {
		void refreshSessions();
	}, [refreshSessions]);

	// 选中会话即连接 SSE；切换/卸载时关闭旧连接（effect cleanup）
	useEffect(() => {
		if (currentId === null) {
			setConnState("idle");
			return;
		}
		const conn = connect(
			currentId,
			(event) => {
				dispatch({ type: "event", event });
			},
			(state) => {
				setConnState(state);
			},
		);
		return () => {
			conn.close();
		};
	}, [currentId]);

	const handleCreate = async (): Promise<void> => {
		const input = window.prompt("新会话工作目录（留空使用服务端默认）", "");
		if (input === null) {
			return; // 用户取消
		}
		const cwd = input.trim();
		try {
			const id = await createSession(cwd === "" ? undefined : cwd);
			await refreshSessions();
			setError(null);
			setCurrentId(id);
			dispatch({ type: "reset" });
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	const handleSelect = (id: string): void => {
		if (id === currentId) {
			return;
		}
		setError(null);
		setCurrentId(id);
		dispatch({ type: "reset" });
	};

	// 空闲发送 = 新 turn（POST messages）；运行中发送 = steer 注入（POST steer）
	const handleSend = async (content: string): Promise<void> => {
		if (currentId === null) {
			return;
		}
		try {
			if (chat.turn === "running") {
				await steerMessage(currentId, content);
			} else {
				await sendMessage(currentId, content);
				setSessions((ss) =>
					ss.map((s) =>
						s.id === currentId ? { ...s, turn: "running" as const } : s,
					),
				);
			}
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	const handleCancel = async (): Promise<void> => {
		if (currentId === null) {
			return;
		}
		try {
			await cancelTurn(currentId);
			setSessions((ss) =>
				ss.map((s) =>
					s.id === currentId ? { ...s, turn: "idle" as const } : s,
				),
			);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	const handleApproval = async (decision: "allow" | "deny"): Promise<void> => {
		if (currentId === null || chat.pendingApproval === null) {
			return;
		}
		try {
			await answerApproval(currentId, chat.pendingApproval.requestId, decision);
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	const handlePlanDecision = async (
		decision: "approve" | "reject" | "annotate",
		note?: string,
	): Promise<void> => {
		if (currentId === null) {
			return;
		}
		try {
			await answerPlan(currentId, decision, note);
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	const current = sessions.find((s) => s.id === currentId) ?? null;

	return (
		<div className="app">
			<SessionList
				sessions={sessions}
				currentId={currentId}
				onSelect={handleSelect}
				onCreate={() => {
					void handleCreate();
				}}
			/>
			<div className="center">
				{connState === "reconnecting" && (
					<div className="banner">连接断开，重连中…</div>
				)}
				{error !== null && <div className="banner banner-error">{error}</div>}
				<ChatView
					state={chat}
					hasSession={currentId !== null}
					onSend={(content) => {
						void handleSend(content);
					}}
					onCancel={() => {
						void handleCancel();
					}}
					onApproval={(decision) => {
						void handleApproval(decision);
					}}
					onPlanDecision={(decision, note) => {
						void handlePlanDecision(decision, note);
					}}
				/>
			</div>
			<AgentPanel
				agents={chat.agents}
				usage={chat.usage}
				turn={chat.turn}
				mainTier={MAIN_TIER_FALLBACK}
				open={chat.panelOpen && !panelCollapsed}
				sessionName={current?.cwd ?? ""}
				onToggle={() => {
					setPanelCollapsed((v) => !v);
				}}
			/>
		</div>
	);
}
