-- User config: pick which plugin backs each interface (explicit override,
-- docs/SPEC.md §9.7 step 4). No UI plugin change needed to swap this.
return {
  interfaces = {
    ["community/subagent"] = "alice/subagents",
  },
}
