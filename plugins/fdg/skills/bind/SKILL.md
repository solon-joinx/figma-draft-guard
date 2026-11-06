---
description: Bind a Figma main file, or switch to a new draft after the main file changes. Use when the user wants to start watching a main file, bind a draft, or update a draft (for example "監看這個主檔" or "幫我更新 draft").
argument-hint: "[Figma main file link]"
---

Walk the user through binding. Always use the language of the conversation and a neutral, professional tone. Cover only the current step. Tool results are English data, so do not paste them to the user as they are.

Keep terms consistent: main file (主檔), draft (Draft), out of date (版本落後), being edited (編輯中), stable (已穩定). Do not guess what designers are doing.

Ask every choice with the AskUserQuestion tool, so the user picks from a menu instead of typing an answer. Write labels in the language of the conversation, and put the recommended option first.

## 1. Record the main file version

Call `start_binding` from fdg. Always pass `language` with the language of this conversation, such as `zh-TW` or `en`. Pass `mainFileUrl` if the user gave a link ($ARGUMENTS). Omit it when updating an existing binding.

- **`missing-link`:** Ask for the main file link. If the user cannot find it, tell them to open the main file and choose Share → Copy link.
- **`no-token` or `auth`:** Ask the user to create a token in Figma under Settings → Security → Personal access tokens, with only `file_metadata:read`, and to paste it in the fdg settings under `/plugin`. Never ask for the token in the conversation. Retry this step afterwards.
- **`bad-record`:** The record is damaged. Ask for the main file link and call `start_binding` again with it, which replaces the record.
- **`not-found`:** Ask the user to check the link and that this Figma account can open the file.
- **Success:** Keep `markerName`. If `mainPhase` is `editing`, convert `mainUpdatedAt` to elapsed minutes and ask with options to update now or wait: "The main file changed N minutes ago, so this version may not be final. Update the draft now anyway?" If the user chooses to wait, end the flow without calling `finish_binding`. Otherwise go to the next step.

## 2. Ask the user to duplicate the draft

Ask the user to do this in Figma:

1. In the main file, open the menu next to the file name and choose Duplicate to your drafts.
2. Close the tab of the old draft.
3. Open the Figwright plugin in the new draft.
4. Reply when finished.

It must be a fresh copy. Tell the user not to rename it yet, and that they can rename it after the marker is written.

## 3. Mark the new draft

Call Figwright `list_files`. Exclude files named exactly like the main file, and look for names containing the main file name. If there are no candidates, ask the user to confirm Figwright is open.

Call `mark_draft` from fdg with a candidate's `sessionId`, one candidate at a time:

- **`marked`:** This is the new draft. Keep its `sessionId`.
- **`old-draft`:** It already has a marker, so try the next candidate. If every candidate is old, ask the user to duplicate again.
- **`no-page`:** No page can hold the marker. Tell the user and stop.

With several candidates, ask the user which is new first. Never write to the main file.

## 4. Choose the comparison scope

Call `compare_context`. If `isFirstComparison` is true, ask for the scope with these options: all pages (recommended), selected pages, or only frames read before. If the user picks selected pages, get the names with `get_pages` and ask a second multi-select question, leaving out divider pages. Save the result with `set_compare_scope`. Otherwise keep the saved scope.

## 5. Compare the design

Ask the user to keep the new draft in front in Figma and not switch tabs for a minute, because `design_diff` only reaches the front file. Then call `run_comparison` from fdg with the `sessionId`. It lists frames, builds or compares baselines, and writes the report on its own.

- **`draft-not-front`:** Ask the user to bring the draft to the front, then call it again.
- **`figwright`:** Tell the user the reason. Do not continue to the next step.
- **Success:** Show the returned `summary` exactly as it is, and do not reword it or add advice.

Do not change any code. The comparison only reports differences. If the user wants a frame's details, read them from the report.

## 6. Finish

Call `finish_binding` with the same `markerName`. Report that watching is on, and remind the user:

- Treat this draft as read-only, and do not delete the marker layer.
- The old draft can be deleted.
- They can now rename the file so it is easier to find in Drafts. If `copiedToClipboard` is true, say the name is on the clipboard and can be pasted. If false, show `suggestedFileName`. Renaming is optional and does not affect watching.
