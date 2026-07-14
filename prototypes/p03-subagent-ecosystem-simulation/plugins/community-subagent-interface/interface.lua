-- Interface descriptor: plain Lua data (docs/SPEC.md §9.6, candidate 1).
-- Same shape proven by p02-lua-interface-descriptor.
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

  events = { "community/subagent-done", "community/subagent-failed" },
}
