---
name: parallel-fix
description: 并行排查多个 bug，汇总冲突检查后一次性提交
---

## Parallel Fix Skill

用于同时处理多个独立 bug，避免串行修复浪费时间。

**使用方式：** `/parallel-fix` 后列出所有 bug，每条一行。

**执行流程：**

1. **并行子 Agent**：为每个 bug 启动独立 Agent，每个 Agent 只做：
   - 用 Grep 定位相关文件，只读必要文件
   - 找到根因，提出最小改动
   - 返回结构化结果：
     ```
     bug_id: #N
     root_cause: 一句话说明
     files_changed: [文件名]
     diff_preview: 改动内容摘要
     ```

2. **协调合并**：所有 Agent 完成后，检查：
   - 多个修复是否改动了同一文件的同一位置（冲突）
   - 合并成单一 changeset

3. **语法检查**：对每个改动的 JS 文件运行 `node -c 文件名` 确认无语法错误

4. **等待确认**：输出统一的 diff 摘要和 commit message，用户确认后执行 `/deploy`
