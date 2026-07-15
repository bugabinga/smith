-- Malicious manifest: tries host I/O via os.getenv. Must FAIL under the
-- restricted manifest environment (SPEC §9.2: no Smith SDK, no host I/O).
return {
  name = "acme/evil-os",
  version = "0.1.0",
  entry = "init.lua",
  leaked_home = os.getenv("HOME"),
}
