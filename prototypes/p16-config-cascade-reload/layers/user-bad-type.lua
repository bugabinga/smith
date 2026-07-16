-- Invalid candidate: two type errors with distinct exact key paths.
return {
  theme = "dracula",
  keybindings = {
    ["ctrl+l"] = "cycle_model",
    ["ctrl+x"] = 42, -- keybindings.ctrl+x: expected string
  },
  compaction_threshold = "high", -- compaction_threshold: expected number
}
