# src/prompt-templates/

prompt templates（M4 Feature⑤）：`prompts/*.md` → `/命令`，支持参数占位。

- `prompt-templates.ts`：
  - `discoverPromptTemplates(dirs, cwd?)`：扫描 `settings.promptsDirs`（相对 cwd）+ `<home>/prompts` + `<cwd>/.hotpot/prompts`；后扫描的同名模板覆盖先扫描的（项目级优先）。
  - `expandTemplate(template, args)`：`$ARGUMENTS` 为全部参数以空格连接，`$1..$9` 为位置参数；引用超过实参数量的位置参数报明确错误。
  - `resolveSlashCommand(input, templates)` / `isSlashInput(input)`：CLI / server 的 `/` 命令解析入口。
- 文件格式：可选 frontmatter（name/description），正文即模板；frontmatter 复用 `frontmatter/frontmatter.ts`。
- 模板展开本身不落盘；调用方（CLI / server）在展开后追加 `prompt/invoked` 事件。
- `index.ts` 是本特性的对外出口。
