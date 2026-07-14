-- Manifest (docs/SPEC.md §9.2).
-- Adapter plugin: implements community/subagent by wrapping bob/agents.
return {
  name = "bob/subagent-adapter",
  version = "0.1.0",
  entry = "init.lua",

  dependencies = { "bob/agents", "community/subagent-interface" },
  implements = { "community/subagent" },
}
