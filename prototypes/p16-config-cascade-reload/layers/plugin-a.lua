-- Layer 3, first plugin contribution (§5.6 layer 3).
return {
  keybindings = {
    ["ctrl+p"] = "plugin_a_palette",
    ["ctrl+g"] = "plugin_a_grep",
  },
  tools = { "read", "grep", "ls", "plugin_a_tool" },
  models = { aliases = { quick = "fast" } },
}
