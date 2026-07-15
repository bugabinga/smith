-- P10 fixture: plugin that stays well under the heap quota.
-- Builds a modest table (a few hundred KB) and returns a summary.
local t = {}
for i = 1, 1000 do
  t[i] = "item-" .. i
end
return { count = #t, note = "small plugin done" }
