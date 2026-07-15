-- Alice's implementation: conforms to community/subagent directly.
-- Carries a private helper that must stay invisible through the interface view.
local agents = {}
local next_id = 0

return {
  spawn = function(task, opts)
    next_id = next_id + 1
    local id = "alice-" .. next_id
    agents[id] = { task = task, state = "running", opts = opts }
    return { id = id }
  end,

  status = function(id)
    local a = agents[id]
    if a then return a.state end
    return "unknown"
  end,

  cancel = function(id)
    if agents[id] then
      agents[id].state = "cancelled"
      return true
    end
    return false
  end,

  -- Private: must NOT leak through the community/subagent view.
  _alice_internal_dump = function()
    return agents
  end,
}
