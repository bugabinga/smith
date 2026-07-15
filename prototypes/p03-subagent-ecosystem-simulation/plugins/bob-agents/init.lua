-- Bob's own API shape. Deliberately incompatible with community/subagent:
--   run_agent(spec) -> numeric run key       (vs spawn(task, opts) -> handle)
--   agent_state(key) -> { phase = ... }      (vs status(id) -> state string)
--   stop_agent(key) -> phase string          (vs cancel(id) -> boolean)
local runs = {}
local n = 0

return {
  run_agent = function(spec)
    n = n + 1
    runs[n] = { spec = spec, phase = "working" }
    return n
  end,

  agent_state = function(key)
    local r = runs[key]
    if not r then return { phase = "gone" } end
    return { phase = r.phase }
  end,

  stop_agent = function(key)
    local r = runs[key]
    if r then
      r.phase = "stopped"
      return "stopped"
    end
    return "gone"
  end,
}
