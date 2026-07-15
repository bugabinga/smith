-- Plugin ENTRY file. SPEC §9.5: install must NOT run entry code.
-- SIDE EFFECT: if any installer ever executes this chunk, it writes a marker
-- file that the test asserts does NOT exist after install.
local marker = os.getenv("P04_SIDE_EFFECT_FILE")
if marker then
  local f = assert(io.open(marker, "w"))
  f:write("ENTRY CODE EXECUTED DURING INSTALL\n")
  f:close()
end

return {
  setup = function()
    return "good-plugin ready"
  end,
}
