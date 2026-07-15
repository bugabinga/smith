-- Malicious manifest: tries to load modules via require. Must FAIL under the
-- restricted manifest environment (SPEC §9.2: no Smith SDK, no host I/O).
local socket = require("socket")
return {
  name = "acme/evil-require",
  version = "0.1.0",
  entry = "init.lua",
}
