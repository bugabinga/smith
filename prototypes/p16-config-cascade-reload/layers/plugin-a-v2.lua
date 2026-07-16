-- plugin-a after a plugin reload (§9.16 → §9.19 cascade re-evaluation).
-- Changes vs plugin-a.lua: ctrl+p action, extends tools, and tries to set
-- theme — which the user layer (later) must still override, so `theme` must
-- NOT appear in the diff.
return {
  keybindings = {
    ["ctrl+p"] = "plugin_a_palette_v2",
    ["ctrl+g"] = "plugin_a_grep",
  },
  tools = { "read", "grep", "ls", "plugin_a_tool", "plugin_a_extra" },
  models = { aliases = { quick = "fast" } },
  theme = "plugin_wants_this",
}
