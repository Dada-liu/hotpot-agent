# src/frontmatter/

最小 frontmatter 解析，skill 与 prompt template 共用。

- `frontmatter.ts` — `parseFrontmatter(text)`：首行须为 `---`，取到下一个 `---` 为止（无收尾围栏则读到文件尾，宽容处理）；只收集 `key: value` 行，值取第一个冒号后的全部内容并裁掉首尾空白。
- 不支持嵌套 YAML、列表、多行值——当前只消费 name/description 两个标量键。
- `index.ts` 是本特性的对外出口。
