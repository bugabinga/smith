-- UI plugin: calls ONLY the community/subagent interface view it is handed.
-- It names no implementation plugin and is byte-identical across scenarios;
-- the user config alone decides which implementation backs the view.
return {
  consumes = "community/subagent",

  run_demo = function(subagent)
    local log = {}
    local handle = subagent.spawn("summarize the changelog", { model = "small" })
    log[#log + 1] = "spawn -> handle " .. handle.id
    log[#log + 1] = "status(" .. handle.id .. ") -> " .. subagent.status(handle.id)
    local ok = subagent.cancel(handle.id)
    log[#log + 1] = "cancel(" .. handle.id .. ") -> " .. tostring(ok)
    local final = subagent.status(handle.id)
    log[#log + 1] = "status(" .. handle.id .. ") -> " .. final
    return {
      log = log,
      ok = ok == true and final == "cancelled",
    }
  end,
}
