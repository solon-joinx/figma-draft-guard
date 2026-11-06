---
description: Check right now whether the Figma main file is newer than the current draft
---

Call `check_status` from fdg and report the result in the language of the conversation, in a neutral, professional tone. Tool results are English data.

Keep terms consistent: main file (主檔), draft (Draft), out of date (版本落後), being edited (編輯中), stable (已穩定).

- **`fresh`:** The draft is in sync.
- **`stale`:** The draft is out of date. Use `phase` to say whether the main file is being edited or stable, give the last change time, and ask with the AskUserQuestion tool whether to update now or later. To update, use the bind skill.
- **`not-ready`:** Draft binding is incomplete. Ask with the AskUserQuestion tool whether to continue.
- **`unbound`:** This project has no bound main file.
- **`failed`:** The version check failed. Give the reason, and never report it as no update.

If the user asks to change the comparison scope, offer the options with the AskUserQuestion tool, then call `set_compare_scope`. It applies from the next comparison, and frames newly in scope have no baseline until then, so say that they will show no differences the first time.
