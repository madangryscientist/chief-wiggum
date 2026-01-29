---
description: Fail a task, stop the loop, and restart
---
Fail a task and restart the loop. Follow these steps exactly:

1. **Identify the task to fail:**
   - If arguments are provided, the first word is the task ID and the rest is the reason: `$ARGUMENTS`
   - If no task ID is provided, call chief-wiggum-observer_list_tasks and find the task with status "in-progress". Use that task's ID.

2. **Mark the task as failed:**
   - Call chief-wiggum_mark_task with the task ID, status "failed"
   - Include the reason if one was provided

3. **Stop the loop:**
   - Call chief-wiggum-observer_stop_loop

4. **Restart the loop in a terminal split:**
   - Use bash to run:
     ```
     if [ -n "$TMUX" ]; then
       tmux split-window -h "chief-wiggum run --force"
     elif [ "$TERM_PROGRAM" = "WarpTerminal" ]; then
       osascript -e 'tell application "System Events" to keystroke "d" using command down' -e 'delay 0.5' -e 'tell application "System Events" to keystroke "chief-wiggum run --force"' -e 'delay 0.2' -e 'tell application "System Events" to keystroke return'
     elif [ -n "$GHOSTTY_RESOURCES_DIR" ]; then
       osascript -e 'tell application "System Events" to keystroke "d" using command down' -e 'delay 0.5' -e 'tell application "System Events" to keystroke "chief-wiggum run --force"' -e 'delay 0.2' -e 'tell application "System Events" to keystroke return'
     elif command -v wezterm &>/dev/null && wezterm cli list &>/dev/null; then
       wezterm cli split-pane --right -- chief-wiggum run --force
     else
       chief-wiggum run --force &
       disown
     fi
     ```

Report what happened: which task was failed, the reason, and that the loop has been restarted.
