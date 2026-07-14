-- Interface descriptor: plain Lua data, no host SDK, no I/O.
-- Claim under test: this shape is expressive enough for community-defined
-- plugin interfaces with runtime validation (docs/SPEC.md §9.6, candidate 1).
return {
  name = "community/subagent",
  generation = 1,

  -- Required exported functions with typed signatures.
  -- type names: "string" | "number" | "boolean" | "table" | "function"
  functions = {
    spawn = {
      params = {
        { name = "task", type = "string" },
        { name = "opts", type = "table", optional = true },
      },
      returns = { { name = "handle", type = "table" } },
    },
    status = {
      params = { { name = "id", type = "string" } },
      returns = { { name = "state", type = "string" } },
    },
    cancel = {
      params = { { name = "id", type = "string" } },
      returns = { { name = "ok", type = "boolean" } },
    },
  },

  -- Events the implementation may emit on the bus (docs/SPEC.md §9.18).
  events = { "community/subagent-done", "community/subagent-failed" },
}
