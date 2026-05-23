-- vcs-tools.lua: agent tools that are pure Lua compositions over smith.vcs.*

local tools = {}

tools.vcs_status = {
  description = "Show working copy status",
  execute = function(self, params)
    return smith.vcs.status()
  end,
}

tools.vcs_diff = {
  description = "Show working-copy diff",
  execute = function(self, params)
    local rev = params and params.rev
    return smith.vcs.diff(rev)
  end,
}

tools.vcs_diff_revs = {
  description = "Diff between two revisions",
  execute = function(self, params)
    local from = params and params.from
    local to = params and params.to
    if not from or from == "" or not to or to == "" then
      return { success = false, error = "from and to required" }
    end
    return smith.vcs.diff_revs(from, to)
  end,
}

tools.vcs_log = {
  description = "Show operation log",
  execute = function(self, params)
    local limit = params and params.limit and tonumber(params.limit) or 10
    return smith.vcs.op_log(limit)
  end,
}

tools.vcs_commit = {
  description = "Create a commit",
  execute = function(self, params)
    local msg = params and params.message or "auto commit"
    return smith.vcs.commit(msg)
  end,
}

tools.vcs_annotate = {
  description = "Annotate file with line history",
  execute = function(self, params)
    local path = params and params.path
    if not path then
      return { success = false, error = "path required" }
    end
    return smith.vcs.annotate(path)
  end,
}

return tools
