-- commands.lua: slash-command-like actions composed entirely in Lua
-- Rust does not implement command logic; it only exposes smith.vcs.* primitives.

local commands = {}

function commands.undo(self)
  return smith.vcs.undo()
end

function commands.redo(self)
  return smith.vcs.redo()
end

function commands.history(self, limit)
  local n = limit and tonumber(limit) or 10
  local result = smith.vcs.op_log(n)
  if not result.success then
    return { success = false, error = result.error }
  end

  local ops = result.entries or {}
  local lines = {}
  for i, op in ipairs(ops) do
    table.insert(lines, string.format("#%d [%s] %s", i, op.id, op.description))
  end
  return {
    success = true,
    output = table.concat(lines, "\n"),
    total = #ops,
  }
end

function commands.restore_file(self, path)
  if not path or path == "" then
    return { success = false, error = "path required" }
  end
  return smith.vcs.restore_paths({ path })
end

function commands.undo_n(self, n)
  local count = tonumber(n) or 0
  if count < 1 then
    return { success = false, error = "n must be >= 1" }
  end

  local done = 0
  for i = 1, count do
    local r = smith.vcs.undo()
    if not r.success then
      return { success = false, error = "undo failed at step " .. i, message = r.message }
    end
    done = done + 1
  end

  return { success = true, undos = done }
end

function commands.undo_file(self, path)
  if not path or path == "" then
    return { success = false, error = "path required" }
  end
  return smith.vcs.restore_paths({ path })
end

return commands
