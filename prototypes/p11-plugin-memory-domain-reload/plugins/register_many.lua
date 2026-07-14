-- register_many.lua: registers many hooks/tools/bus subscriptions so that
-- domain-keyed registry teardown (SPEC §9.16) is exercised at scale on every
-- reload cycle: 200 hooks + 200 tools + 50 bus subscriptions.

for i = 1, 200 do
  local n = i
  smith.register_hook("many/hook_" .. n, function()
    return n
  end)
  smith.register_tool("many/tool_" .. n, function()
    return n * 2
  end)
end

for i = 1, 50 do
  smith.bus_on("many/topic_" .. i, function(p)
    return p
  end)
end
