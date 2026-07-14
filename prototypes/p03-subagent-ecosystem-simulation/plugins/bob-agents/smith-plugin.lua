-- Manifest (docs/SPEC.md §9.2).
-- Bob's plugin predates the community interface: it declares NO
-- `implements` field and exports its own incompatible API shape.
return {
  name = "bob/agents",
  version = "2.0.0",
  entry = "init.lua",
}
