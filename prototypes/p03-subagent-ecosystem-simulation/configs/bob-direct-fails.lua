-- User config (intentionally wrong): bind Bob's incompatible plugin directly
-- to community/subagent, bypassing the adapter. Resolution must fail with a
-- clear interface error.
return {
  interfaces = {
    ["community/subagent"] = "bob/agents",
  },
}
