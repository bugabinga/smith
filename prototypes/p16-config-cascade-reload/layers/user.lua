-- Layer 4: user config. Overrides ONE keybinding — under leaf-merge the
-- builtin bindings survive; under layer-replace they would be wiped.
return {
  theme = "catppuccin",
  keybindings = {
    ["ctrl+l"] = "cycle_model",
  },
  model = "quick",
  experimental_shimmer = true, -- unknown top-level key: warn context
}
