---
description: Start a chief-wiggum development loop in a terminal split
---
Launch a chief-wiggum loop in a new terminal split. Use bash to run the following script:

```
if [ -n "$TMUX" ]; then
  tmux split-window -h "chief-wiggum run $ARGUMENTS"
elif [ "$TERM_PROGRAM" = "WarpTerminal" ]; then
  osascript -e 'tell application "System Events" to keystroke "d" using command down' -e 'delay 0.5' -e 'tell application "System Events" to keystroke "chief-wiggum run '"$ARGUMENTS"'"' -e 'delay 0.2' -e 'tell application "System Events" to keystroke return'
elif [ -n "$GHOSTTY_RESOURCES_DIR" ]; then
  osascript -e 'tell application "System Events" to keystroke "d" using command down' -e 'delay 0.5' -e 'tell application "System Events" to keystroke "chief-wiggum run '"$ARGUMENTS"'"' -e 'delay 0.2' -e 'tell application "System Events" to keystroke return'
elif command -v wezterm &>/dev/null && wezterm cli list &>/dev/null; then
  wezterm cli split-pane --right -- chief-wiggum run $ARGUMENTS
else
  chief-wiggum run $ARGUMENTS &
  disown
  echo "Started chief-wiggum loop in background (PID: $!)"
fi
```

If arguments are provided, pass them through (e.g. `/cw-loop -f docs/prompt.md -t docs/tasks.md -M M1`). Otherwise run with no arguments to use defaults.
