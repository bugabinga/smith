-- User config: back community/subagent with Bob's engine via the adapter.
-- Only this file differs from configs/alice.lua; every plugin is unchanged.
return {
  interfaces = {
    ["community/subagent"] = "bob/subagent-adapter",
  },
}
