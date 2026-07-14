-- P10 fixture: unbounded table growth. Must be stopped by the heap quota
-- (native set_memory_limit or the host's hook-based fallback), never by
-- crashing the host.
local t = {}
local i = 0
while true do
  i = i + 1
  t[i] = { i, i * 2, "payload-payload-payload-" .. i }
end
