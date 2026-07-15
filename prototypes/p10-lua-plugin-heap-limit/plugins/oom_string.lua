-- P10 fixture: unbounded string growth via repeated concatenation.
-- Doubles the string each iteration, so allocation sizes grow geometrically.
local s = "xxxxxxxxxxxxxxxx"
while true do
  s = s .. s
end
