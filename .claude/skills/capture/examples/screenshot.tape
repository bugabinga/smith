# Single still of a TUI. Replace `top` with the app under capture.
# No Output line: a tape with only Screenshot renders no gif.
Require top
Set FontSize 20
Set Width 1200
Set Height 700
Set Padding 12
Set Theme "Catppuccin Mocha"
Env LANG "C.UTF-8"
Type "top"
Enter
Sleep 3s
Screenshot shot.png
Type "q"
Sleep 500ms
