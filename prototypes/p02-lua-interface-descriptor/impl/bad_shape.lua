-- Non-conforming implementation: `status` has the wrong shape
-- (string constant instead of a function).
return {
  implements = "community/subagent",

  spawn = function(task, opts)
    return { id = "y" }
  end,

  status = "always-running",

  cancel = function(id)
    return true
  end,
}
