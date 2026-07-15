-- Manifest (docs/SPEC.md §9.2).
return {
  name = "alice/subagents",
  version = "0.3.1",
  entry = "init.lua",

  dependencies = { "community/subagent-interface" },
  -- Optional manifest field (§9.2 "implemented interfaces").
  implements = { "community/subagent" },
}
