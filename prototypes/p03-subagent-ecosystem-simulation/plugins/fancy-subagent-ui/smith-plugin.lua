-- Manifest (docs/SPEC.md §9.2).
-- Consumer plugin: depends only on the interface package, never on an
-- implementation. `consumes` is the prototype's name for that declaration.
return {
  name = "fancy/subagent-ui",
  version = "1.2.0",
  entry = "init.lua",

  dependencies = { "community/subagent-interface" },
  consumes = { "community/subagent" },
}
