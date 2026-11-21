---
name: computer-use
description: Use when 操控电脑：点击/输入/截屏/键盘操作桌面软件（Word/Excel/微信等）。用户点名 /computer-use 或要求 AI 亲自操作桌面应用时加载；网页操作改用 /browser-use。
description_en: Drive desktop apps (Word, Excel, WeChat, etc.) with the computer_* tools: request access, confirm the foreground app, take a canAct full-screen screenshot, act with its screenshot_id, re-screenshot after every pointer action, verify each change with observe, and know the read/click tier limits plus the stop entry in the top-right mini window.
---

# 电脑操控（computer-use）

用 `computer_request_access` / `computer_screenshot` / `computer_action` 三个工具操作桌面软件。核心循环只有一句话：**授权 → 确认前台 → 截图 → 一个动作 → 验证**。所有校验都是 fail-closed：任何一步不过关就停下来重新截图，绝不凭记忆或上一张图猜坐标。

## 标准循环（严格按顺序）

1. **申请授权**：`computer_request_access(apps=["进程名或窗口标题片段"], reason="一句话说明为什么")`。例如 `["WINWORD"]`、`["EXCEL"]`、`["WeChat"]`。用户同意后本进程内一直有效（重启后要重新授权）；用户拒绝就如实说明并停止，不要绕过。
2. **让目标应用处于前台**：请用户点一下目标窗口，或用 `computer_action(action="focus", hwnd=…)`（hwnd 从截图结果返回的 `foreground` 里取）。前台不是目标应用时，后续一切动作都会被拒绝。
3. **拿可操作截图**：`computer_screenshot`（默认全屏）。只有返回 `canAct=true` 的**全屏**截图才带有效的 `screenshot_id`；`target="window"` 的窗口截图仅供观察，不能拿来动手。记下返回 note 里的前台进程名与权限级别（tier）。
4. **执行动作**：`computer_action`，坐标直接用这张截图上的**原始像素**（缩放由工具处理）。一次只做一个动作：
   - **指针动作**（left_click / right_click / middle_click / double_click / triple_click / move / drag / scroll）：执行成功后那张截图立即作废，下一个动作前必须重新 `computer_screenshot`。
   - **键盘动作**（type / key）：目标窗口与键盘焦点都没变时，可以沿用同一个 `screenshot_id` 连续输入（分段打长文本、`key` 按 Tab/Enter 后继续 type）。
   - 关键动作（提交、保存、发送、删除确认）传 `observe: true`，在同一次调用里拿操作后的全屏截图。
5. **验证结果**：看 observe 附带的截图或重新截图，确认界面真的出现了预期变化（弹窗出现、保存成功、内容更新）。没出现就先读错误信息判断原因，调整后重试；不要盲目重放同一个动作。

## 边界与已知坑

- **权限分层（系统强制，不是建议）**：浏览器在前台 = read 级（只能看，点击/输入全被拒）；终端/IDE = click 级（只许左键，不许输入/右键/拖拽）。要在网页上操作改用 browser_* 工具（/browser-use），要在终端跑命令用 run_command——不要试图用 computer_action 绕过，会被策略直接挡下。
- **截图失效就重截**：动作报「前台窗口已变化 / 键盘焦点已变化 / 显示器布局已变化 / 截图所记录的前台窗口已变化」时，一律重新截图再继续。截图像素坐标只对那一帧有效，窗口移动、缩放、弹出对话框都会让旧坐标作废。
- **单点校验**：一个动作只改一件事，点完看结果再定下一个坐标。不要把多个坐标串成一条盲指令链连发——中途弹窗、焦点变化会让后面的全部点错位置。
- **Qt 自绘类应用（微信、部分国产软件）**：没有 UIA 控件树，界面元素全靠像素识别；窗口缩放后渲染可能不跟随 resize，旧截图上的按钮位置不可信。必须：每次缩放/弹层后重新截图再点；对「看起来是按钮」的位置先单击一次、看截图确认有反馈，再进行下一步；绝不按旧截图的坐标连点。
- **同一回复内的失败熔断**：同一次回复里某个自动化工具失败后，后续同类调用会被自动跳过并提示。先读失败原因（前台不匹配 / 坐标无效 / 权限不足），改变做法再试，而不是原样重发。
- **停止入口**：操控期间 FinalCheck 主窗口会缩成屏幕右上角的迷你窗（红色横条「FinalCheck 操控中」）。用户要中止时，点右上角迷你窗里的停止条即可恢复窗口并停止操控；告知用户这个入口，不要让用户去翻菜单。
- **适用范围**：computer_* 留给「只能靠界面点」的场景（桌面软件对话框、系统设置、没有命令行入口的 GUI）。终端与编辑器里的操作优先 run_command / 文件工具，更快也更可靠。
