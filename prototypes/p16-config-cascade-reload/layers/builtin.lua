-- Layer 2: built-in Lua defaults (§5.6). Pure data table.
return {
  theme = "gruvbox",
  keybindings = {
    ["ctrl+c"] = "abort",
    ["ctrl+l"] = "clear_screen",
    ["ctrl+r"] = "history_search",
  },
  tools = { "read", "grep", "ls" },
  model = "sonnet",
  compaction_threshold = 0.8,
  models = {
    aliases = {
      sonnet = "anthropic/claude-sonnet-4",
      fast = "anthropic/claude-haiku-4",
    },
  },
}
