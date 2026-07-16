-- Layer 3, second plugin contribution: later plugin overrides earlier
-- (proves intra-layer ordering: plugin-b's ctrl+g wins over plugin-a's).
return {
  keybindings = {
    ["ctrl+g"] = "plugin_b_goto",
  },
}
