# Short interaction demo → GIF (+ still of the end state).
# Replace `top` and the keystrokes with the app under capture.
Require top
Output demo.gif
Set FontSize 20
Set Width 1200
Set Height 700
Set Padding 12
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set Framerate 24
Type "top"
Enter
Sleep 3s
# drive the app: sort by memory, then back
Type "M"
Sleep 2s
Type "P"
Sleep 2s
Screenshot end-state.png
Type "q"
Sleep 500ms
