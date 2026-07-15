-- Manifest (docs/SPEC.md §9.2): plain data, restricted environment, no SDK.
return {
  name = "community/subagent-interface",
  version = "1.0.0",
  entry = "interface.lua",

  -- Optional manifest field (§9.2 "exported interfaces"): this package is an
  -- interface-only plugin (§9.6). Its entry returns the descriptor as data.
  interfaces = { "community/subagent" },
}
