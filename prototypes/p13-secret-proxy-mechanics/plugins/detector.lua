-- p13 detector plugin (SPEC §6.7 / §9.8).
--
-- Detection MECHANISM belongs to the plugin: this one pattern-matches
-- `secret%-%w+` tokens in content and registers them through the host
-- function smith.secret.register(value, label). Masking MECHANICS stay in
-- Smith: the ingestion scan runs AFTER these hooks, so a value registered
-- here must land masked in the very content that surfaced it.

local M = {}

local function detect(s)
  for tok in s:gmatch("secret%-%w+") do
    smith.secret.register(tok, "detected:" .. tok:sub(8))
  end
end

-- §9.8 tool_result contract: { content = <replacement> } | { retry } |
-- { cancel } | nil (keep). This one registers but keeps content untouched.
function M.tool_result(ev)
  detect(ev.content)
  return nil
end

-- §9.8 input contract: { action = "handled"|"continue", text = <transformed>? }.
-- This one registers AND transforms; the registered value survives the
-- transform verbatim, so the post-hook scan still masks it.
function M.input(ev)
  detect(ev.text)
  return { action = "continue", text = "[seen] " .. ev.text }
end

-- EDGE (c): registers from the PRE-transform text, then re-encodes the
-- content (uppercase) so the registered value appears only in derived form
-- post-transform. The exact-substring scan runs on post-transform content
-- only and will miss it.
function M.input_upper(ev)
  detect(ev.text)
  return { action = "continue", text = ev.text:upper() }
end

return M
