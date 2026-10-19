// 包入口：给发布包（hotpot-agent）与测试复用 CLI 的进程级入口，不在这里写逻辑。
export {
	type ChatCliArgs,
	parseChatArgs,
	runChatCli,
} from "./chat.ts";
