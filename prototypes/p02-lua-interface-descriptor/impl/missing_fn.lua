-- Non-conforming implementation: required function `cancel` is absent.
return {
  implements = "community/subagent",

  spawn = function(task, opts)
    return { id = "x" }
  end,

  status = function(id)
    return "running"
  end,

  -- cancel is missing
}
