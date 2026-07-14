-- Conforming implementation of community/subagent.
-- Includes a private extra field that must be hidden by the interface view.
local agents = {}
local next_id = 0

return {
  implements = "community/subagent",

  spawn = function(task, opts)
    next_id = next_id + 1
    local id = "agent-" .. next_id
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

  -- Private helper: must NOT be visible through the interface view.
  _internal_debug_dump = function()
    return agents
  end,
}
