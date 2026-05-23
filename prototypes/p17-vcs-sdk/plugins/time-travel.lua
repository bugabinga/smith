-- time-travel.lua: all timeline/time-travel UX is Lua composition.
-- Rust only provides smith.vcs.* + smith.shortcut.register table.

local M = {}

M.state = {
  keybinds_registered = false,
}

local function detect_type(desc)
  if not desc then return "op" end
  if desc:find("^edit:") then return "edit"
  elseif desc:find("^create:") then return "create"
  elseif desc:find("^delete:") then return "delete"
  elseif desc:find("^commit") then return "commit"
  elseif desc:find("snapshot") then return "snapshot"
  else return "unknown" end
end

local KEYBINDS = {
  { key = "Alt+t", mode = "timeline", action = "toggle_timeline" },
  { key = "Alt+i", mode = "timeline", action = "inspect_selected" },
  { key = "Alt+d", mode = "timeline", action = "diff_selected" },
  { key = "Alt+u", mode = "timeline", action = "undo_to_selected" },
  { key = "Alt+r", mode = "timeline", action = "diff_vs_prev" },
  { key = "Alt+b", mode = "timeline", action = "branch_from_here" },
}

local function register_keybinds()
  if M.state.keybinds_registered then
    return { success = true, registered = true }
  end

  if not smith or not smith.shortcut or not smith.shortcut.register then
    return { success = false, error = "smith.shortcut.register unavailable" }
  end

  for _, b in ipairs(KEYBINDS) do
    smith.shortcut.register(b.key, { mode = b.mode, action = b.action }, function() end)
  end

  M.state.keybinds_registered = true
  return { success = true, registered = #KEYBINDS }
end

-- Timeline data from jj log (commit change IDs) not op_log (operation IDs).
-- op_log returns operation IDs which are only valid for op restore/show,
-- not for diff -r which expects commit/change IDs.
local function pick_ops(limit)
  local history = smith.vcs.op_log(limit or 50)
  if not history or not history.success then
    return nil, history and history.error or "op_log failed"
  end
  return history.entries or {}, nil
end

function M.timeline(self, limit)
  local limit_n = tonumber(limit or 50) or 50
  local entries, err = pick_ops(limit_n)
  if not entries then
    return { success = false, error = err }
  end

  local timeline = {}
  for i, op in ipairs(entries) do
    timeline[i] = {
      index = i,
      id = op.id,
      description = op.description,
      timestamp = op.timestamp,
      op_type = detect_type(op.description),
    }
  end

  return {
    success = true,
    total = #timeline,
    timeline = timeline,
    keymap = KEYBINDS,
  }
end

local function resolve_entry(ops, index)
  local i = tonumber(index or 1) or 1
  if i < 1 then return nil end
  return ops[i]
end

function M.inspect(self, op_index)
  local ops, err = pick_ops(math.max(1, tonumber(op_index or 1) or 1) + 1)
  if not ops then
    return { success = false, error = err }
  end

  local op = resolve_entry(ops, tonumber(op_index or 1) or 1)
  if not op then
    return { success = false, error = "no operation at index " .. tostring(op_index) }
  end

  local show = smith.vcs.op_show(op.id)
  local status = smith.vcs.status()
  return {
    success = true,
    operation = op,
    op_show = show,
    current_status = status,
  }
end

function M.diff_view(self, op_index)
  -- diff_view: show diff between a past state and current.
  -- Uses @- revset chain. jj @- = first parent, @-- = second parent, etc.
  -- Note: jj inserts snapshot commits between user commits, so the @- chain
  -- may not correspond 1:1 to op_log entries. We diff @ (current) vs nothing
  -- for index=1 (last commit's changes), and fall back gracefully.
  local idx = tonumber(op_index or 1) or 1
  if idx < 1 then
    return { success = false, error = "invalid index" }
  end

  -- For index 1, diff just the last commit: @ vs @-
  local rev = "@-"
  if idx > 1 then
    -- For deeper history, use parents() revset function
    rev = string.format("latest(ancestors(@, %d))", idx)
  end
  local diff = smith.vcs.diff_revs(rev, "@")
  if not diff.success then
    return { success = false, error = diff.error }
  end

  return {
    success = true,
    target = { index = idx },
    diff = diff,
  }
end

function M.compare_previous(self, op_index)
  local idx = tonumber(op_index or 1) or 1
  local ops, err = pick_ops(idx + 1)
  if not ops then
    return { success = false, error = err }
  end
  if idx < 1 or idx >= #ops then
    return { success = false, error = "need a previous operation to compare" }
  end

  local op = resolve_entry(ops, idx)
  local prev = resolve_entry(ops, idx + 1)
  if not (op and prev) then
    return { success = false, error = "missing operation pair" }
  end

  -- Use ancestors() revset for reliable comparison across snapshot commits
  local rev_current = string.format("latest(ancestors(@, %d))", idx)
  local rev_prev = string.format("latest(ancestors(@, %d))", idx + 1)
  local diff = smith.vcs.diff_revs(rev_prev, rev_current)
  if not diff.success then
    return { success = false, error = diff.error }
  end

  return {
    success = true,
    current = op,
    previous = prev,
    diff = diff,
  }
end

function M.undo_to(self, op_index)
  local ops, err = pick_ops(math.max(1, tonumber(op_index or 1) or 1))
  if not ops then
    return { success = false, error = err }
  end

  local op = resolve_entry(ops, tonumber(op_index or 1) or 1)
  if not op then
    return { success = false, error = "no operation at index " .. tostring(op_index) }
  end

  return smith.vcs.op_restore(op.id)
end

function M.registered_shortcuts(self)
  if not smith or not smith.shortcut or not smith.shortcut.registered then
    return { success = false, error = "smith.shortcut.registered unavailable" }
  end
  return smith.shortcut.registered()
end

register_keybinds()

return M
