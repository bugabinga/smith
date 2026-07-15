-- grow.lua: allocates Lua memory on every hook call.
--
-- Every allocation stays reachable via `chunks`, so the domain's Lua heap
-- grows for the domain's whole lifetime. Reclaim can only come from dropping
-- the whole domain (SPEC §9.16), never from per-call cleanup.

local chunks = {}

smith.register_hook("grow/on_tick", function(n)
  -- ~4 KiB unique string per call, kept alive forever (within this domain).
  chunks[#chunks + 1] = string.rep("x", 4096) .. tostring(n)
  return #chunks
end)

smith.register_tool("grow/stats", function()
  local bytes = 0
  for _, c in ipairs(chunks) do
    bytes = bytes + #c
  end
  return bytes
end)

smith.bus_on("grow/topic", function(payload)
  return payload
end)
