-- Invalid name: uppercase and '.' are outside [a-z0-9_-] (SPEC §9.2).
return {
  name = "Acme/Bad.Plugin",
  version = "0.1.0",
  entry = "init.lua",
}
