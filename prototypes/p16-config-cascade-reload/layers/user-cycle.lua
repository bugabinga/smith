-- Invalid candidate: alias graph cycle. Note the EFFECTIVE model is the CLI
-- flag (concrete), so only whole-graph cycle detection catches this — chasing
-- just the active model's chain would let a latent cycle into the config.
return {
  theme = "dracula",
  model = "loopy",
  models = {
    aliases = {
      loopy = "swoopy",
      swoopy = "loopy",
    },
  },
}
