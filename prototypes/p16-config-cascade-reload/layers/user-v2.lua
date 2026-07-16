-- user.lua "edited between loads" for reload-ok.
-- Changes: theme, adds keybindings.ctrl+t, compaction_threshold.
-- Also changes `model` — but the CLI flag masks it, so the effective diff
-- must NOT contain `model`.
return {
  theme = "nord",
  keybindings = {
    ["ctrl+l"] = "cycle_model",
    ["ctrl+t"] = "toggle_tree",
  },
  model = "sonnet",
  compaction_threshold = 0.75,
  experimental_shimmer = true,
}
