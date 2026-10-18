# src/skills/

skill 发现（M4 Feature④）：递归扫描 `SKILL.md`，只产出清单，正文由模型按需读取。

- `skills.ts` — `discoverSkills(dirs)`：递归扫描给定目录，解析 frontmatter 的 name/description；name 缺省取 `SKILL.md` 所在目录名，description 缺省空串；同名 skill 后扫描的目录优先；目录不存在/不可读静默跳过。
- 产出 `Skill { name, description, path }` 清单，供编排层注入系统提示词；渐进式加载——模型用 read 工具按 `path` 读取正文。
- frontmatter 复用 `frontmatter/frontmatter.ts`。
- `index.ts` 是本特性的对外出口。
