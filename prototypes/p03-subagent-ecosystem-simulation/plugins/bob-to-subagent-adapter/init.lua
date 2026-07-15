-- Adapter: normalizes bob/agents into the community/subagent interface.
-- Exports a factory instead of a flat implementation table: the plugin
-- manager injects the wrapped plugin's export (`adapts` names it) and the
-- factory returns a community/subagent-shaped table.
return {
  adapts = "bob/agents",

  make = function(bob)
    local keys = {} -- community string id -> bob numeric run key
    local next_id = 0

    local function to_state(phase)
      if phase == "working" then return "running" end
      if phase == "stopped" then return "cancelled" end
      return "unknown"
    end

    return {
      spawn = function(task, opts)
        local key = bob.run_agent({ prompt = task, model = opts and opts.model })
        next_id = next_id + 1
        local id = "bob-" .. next_id
        keys[id] = key
        return { id = id }
      end,

      status = function(id)
        local key = keys[id]
        if not key then return "unknown" end
        return to_state(bob.agent_state(key).phase)
      end,

      cancel = function(id)
        local key = keys[id]
        if not key then return false end
        return bob.stop_agent(key) == "stopped"
      end,
    }
  end,
}
