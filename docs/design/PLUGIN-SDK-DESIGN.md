# smith Plugin SDK Design

> **Historical document.** This design doc captures early plugin system
> exploration. The canonical plugin specification is `docs/SPEC.md` §9.
> Sections below that contradict `docs/SPEC.md` are stale.

## Overview

Smith's plugin system uses **Lua** (not TypeScript). Plugins are Lua modules that
extend smith's behavior. The SDK is exposed as Lua globals and modules registered
by smith-harness via mlua.

## Core Principle

Plugins are Lua scripts. They can:
- Register custom tools callable by the LLM
- Subscribe to lifecycle events
- Register slash commands
- Register keyboard shortcuts
- Override/add providers and models
- Control TUI layout and widgets
- Access sandboxed filesystem and environment

Smith keeps Rust core lean: Rust exposes **primitives** (tools, widgets,
filesystem, VCS, provider registry, event routing), while user-visible features
are Lua plugins. Built-in plugins and user plugins use the same SDK surface — no
private second-class API. Features such as time-travel, `/undo`, VCS tools,
default layout, and built-in file tools compose primitives from Lua.

## Plugin Locations

| Location | Scope |
|----------|-------|
| `~/.smith/plugins/*.lua` | Global |
| `~/.smith/plugins/*/init.lua` | Global (directory) |
| `.smith/plugins/*.lua` | Project-local |
| `.smith/plugins/*/index.lua` | Project-local (directory) |

## Plugin Manifest

```lua
-- ~/.smith/plugins/my-plugin/init.lua
-- or ~/.smith/plugins/my-plugin.lua

return function(smith)
    -- Register tools, events, commands, etc.
end
```

## SDK API

### smith.tool - Register Custom Tools

```lua
smith.tool.register({
    name = "my_tool",
    description = "What this tool does (shown to LLM)",
    parameters = {
        type = "object",
        properties = {
            name = { type = "string", description = "Name to greet" },
            action = { type = "string", enum = { "list", "add" } },
        },
        required = { "name" },
    },
    execute = function(input, ctx)
        return {
            content = { { type = "text", text = "Hello, " .. input.name .. "!" } },
        }
    end,
})
```

### smith.on - Subscribe to Events

```lua
-- Session lifecycle
smith.on("session_start", function(event, ctx)
    ctx.ui.notify("Session started!", "info")
end)

smith.on("session_shutdown", function(event, ctx)
    -- cleanup
end)

-- Tool events (can block)
smith.on("tool_call", function(event, ctx)
    if event.tool_name == "bash" and event.input.command:find("rm%-rf") then
        local ok = ctx.ui.confirm("Dangerous!", "Allow rm -rf?")
        if not ok then
            return { block = true, reason = "Blocked by user" }
        end
    end
end)

-- Modify tool results
smith.on("tool_result", function(event, ctx)
    return { content = event.content }  -- can modify
end)

-- Input interception
smith.on("input", function(event, ctx)
    if event.text == "ping" then
        ctx.ui.notify("pong", "info")
        return { action = "handled" }
    end
    return { action = "continue" }
end)

-- Agent events
smith.on("agent_start", function(event, ctx) end)
smith.on("agent_end", function(event, ctx) end)
smith.on("turn_start", function(event, ctx) end)
smith.on("turn_end", function(event, ctx) end)

-- Message streaming
smith.on("message_start", function(event, ctx) end)
smith.on("message_update", function(event, ctx) end)
smith.on("message_end", function(event, ctx) end)

-- Context modification (before each LLM call)
smith.on("context", function(event, ctx)
    return { messages = event.messages }  -- can modify
end)

-- Provider request inspection
smith.on("before_provider_request", function(event, ctx)
    -- event.payload - inspect or replace
end)

-- Model selection
smith.on("model_select", function(event, ctx)
    ctx.ui.notify("Model: " .. event.model.id, "info")
end)
```

### smith.command - Register Slash Commands

```lua
smith.command.register("stats", {
    description = "Show session statistics",
    handler = function(args, ctx)
        local count = ctx.session.entry_count()
        ctx.ui.notify(count .. " entries", "info")
    end,
})

-- With autocomplete
smith.command.register("deploy", {
    description = "Deploy to environment",
    autocomplete = function(prefix)
        return { { value = "dev", label = "Development" },
                 { value = "staging", label = "Staging" },
                 { value = "prod", label = "Production" } }
    end,
    handler = function(args, ctx)
        ctx.ui.notify("Deploying to " .. args, "info")
    end,
})
```

### smith.shortcut - Register Keyboard Shortcuts

```lua
smith.shortcut.register("ctrl+shift+p", {
    description = "Toggle plan mode",
    handler = function(ctx)
        ctx.ui.notify("Toggled!", "info")
    end,
})
```

### smith.provider – Unified Provider API

One function handles both adding and overriding. If the provider name
already exists (built-in or previously registered), it merges/overrides.
If new, it adds.

```lua
-- Add new provider
smith.provider.register("ollama", {
    base_url = "http://localhost:11434",
    api = "openai-completions",
    models = {
        {
            id = "llama3",
            name = "Llama 3",
            reasoning = false,
            input = { "text" },
            cost = { input = 0, output = 0, cache_read = 0, cache_write = 0 },
            context_window = 8192,
            max_tokens = 4096,
        },
    },
})

-- Override existing provider (merges fields, keeps built-in models unless replaced)
smith.provider.register("anthropic", {
    base_url = "https://proxy.example.com",
})

-- Full override with custom models
smith.provider.register("anthropic", {
    base_url = "https://proxy.example.com",
    api_key = "ANTHROPIC_PROXY_KEY",
    models = {
        {
            id = "claude-sonnet-4-20250514",
            name = "Claude 4 Sonnet (proxy)",
            reasoning = true,
            input = { "text", "image" },
            cost = { input = 0.000003, output = 0.000015, cache_read = 0.0000003, cache_write = 0.000012 },
            context_window = 200000,
            max_tokens = 16384,
        },
    },
})

-- Remove a provider entirely
smith.provider.unregister("my-proxy")
```

**Merge rules:**
- `base_url`: override
- `api_key`: override
- `api`: override
- `headers`: merge (new keys added, existing overridden)
- `models`: merge by ID (see below)
- `oauth`: if provided, replaces OAuth config
- Omitted fields: keep existing value

**Model merge strategy:**

By default, models are merged by ID — new models are added, existing IDs are
overridden field-by-field (same rules as provider: override scalar fields, merge
tables, keep omitted fields). This is safe for partial updates.

```lua
-- Override just the cost of one model (keeps all other models)
smith.provider.register("anthropic", {
    models = {
        { id = "claude-sonnet-4", cost = { input = 0, output = 0 } },
    },
})

-- Replace ALL models for a provider
smith.provider.register("anthropic", {
    models = { ... },
    replace_models = true,  -- drop all built-in, use only these
})
```

**Remove specific models:**
```lua
smith.provider.unregister_model("anthropic", "claude-3-haiku")
```

### smith.tui - Control TUI Layout & Widgets

```lua
-- Create widget instances
local status_bar = smith.tui.widget.truncated_text("ctx 75% | $0.02")
local messages = smith.tui.widget.virtual_scroll()
local editor = smith.tui.widget.editor()
local hints = smith.tui.widget.truncated_text("[Tab] complete  [Ctrl+L] model")

-- Compose layout
local layout = smith.tui.layout.column({
    smith.tui.layout.widget(status_bar),
    smith.tui.layout.expanded(
        smith.tui.layout.scrollable(
            smith.tui.layout.widget(messages),
            "vertical"
        )
    ),
    smith.tui.layout.box({
        border = smith.tui.border.rounded("Input"),
        child = smith.tui.layout.widget(editor),
    }),
    smith.tui.layout.widget(hints),
})

-- Set as center layout
smith.tui.set_center_layout(layout)

-- Populate north panel
smith.tui.set_north_panel(smith.tui.layout.column({
    smith.tui.widget.text("Debug Info"),
}))
```

### smith.fs - Sandboxed Filesystem Access

```lua
-- Read file (within sandbox)
local content = smith.fs.read("path/to/file")

-- Write file (within sandbox)
smith.fs.write("path/to/file", "content")

-- List directory
local entries = smith.fs.list("path/to/dir")

-- Check existence
local exists = smith.fs.exists("path/to/file")

-- Glob
local files = smith.fs.glob("src/**/*.rs")
```

### smith.env - Environment Access

```lua
-- Read env var (read-only within sandbox)
local home = smith.env.get("HOME")

-- Get all allowed env vars
local vars = smith.env.list()
```

### smith.credentials - Credential Access

```lua
-- Read credential for provider
local key = smith.credentials.get("anthropic")

-- Store credential
smith.credentials.set("anthropic", "sk-...")
```

### smith.send_message - Inject Messages

```lua
-- Send steer message (during streaming)
smith.send_message("Focus on error handling", { deliver_as = "steer" })

-- Send follow-up (after agent finishes)
smith.send_message("Then summarize", { deliver_as = "followUp" })

-- Send user message
smith.send_user_message("What is 2+2?")
```

### smith.active_tools - Manage Active Tools

```lua
-- Get active tools
local active = smith.active_tools.get()

-- Get all tools
local all = smith.active_tools.all()

-- Set active tools
smith.active_tools.set({ "read", "bash", "my_tool" })
```

### smith.vcs - Version-Control Primitives

`smith.vcs.*` exposes structured primitives backed by smith's internal jj state
and targeted gitoxide (`gix`) queries. Higher-level behavior lives in Lua
plugins. The API must not expose jj/gix implementation details directly; Lua
receives stable smith-shaped tables.

Read-only/query primitives:

```lua
smith.vcs.status()              -- { modified = {}, added = {}, deleted = {}, renamed = {} }
smith.vcs.diff(opts)            -- { hunks = {}, text = "..." }
smith.vcs.diff_revs(a, b)       -- diff between revisions/operations
smith.vcs.op_log({ limit = 50 })-- { { id, description, time, op_type } }
smith.vcs.op_show(op_id)        -- { id, description, diff, files }
smith.vcs.annotate(path, opts)  -- line attribution/blame data
smith.vcs.interdiff(a, b)       -- patch-vs-patch comparison (jj)
smith.vcs.evolog(rev)           -- logical change evolution (jj)
```

Mutation primitives:

```lua
smith.vcs.commit(message)              -- internal/built-in use after mutating tools
smith.vcs.undo()                       -- reverse latest operation
smith.vcs.redo()                       -- re-apply latest undone operation
smith.vcs.op_restore(op_id)            -- restore repo to an operation
smith.vcs.restore_paths(paths, rev)    -- selective file restore
smith.vcs.split(opts)                  -- split current change
smith.vcs.squash(source, dest)         -- combine changes
smith.vcs.parallelize(revs)            -- mark changes independent
smith.vcs.sparse(paths)                -- materialize only selected paths
smith.vcs.workspace_add(name, opts)    -- create additional jj workspace
```

Safety rules:
- Validate operation IDs, paths, and commit messages before invoking jj.
- Mutating primitives are explicit; inspection APIs are read-only by default.
- Store jj state under `$XDG_DATA_HOME/smith/<project-hash>/jj-state` and use a
  project `.jj` symlink with absolute `git_target` to avoid directory pollution.
- Built-in time-travel and VCS tools are Lua plugins using this namespace.

## Context Object (ctx)

Passed to event handlers, tool execute, command handlers:

```lua
ctx = {
    -- UI methods
    ui = {
        notify = function(message, level) end,        -- "info" | "success" | "error" | "warning"
        confirm = function(title, message) -> bool end,
        select = function(title, items) -> item end,
        input = function(title, placeholder) -> str end,
        set_status = function(key, text) end,
        set_widget = function(key, lines) end,
    },

    -- Session access (read-only)
    session = {
        id = "...",
        name = "...",
        entries = function() -> table end,
        entry_count = function() -> number end,
        branch = function() -> table end,
    },

    -- Model info
    model = {
        id = "...",
        provider = "...",
    },

    -- Working directory
    cwd = "/path/to/project",

    -- Abort signal
    signal = AbortSignal,

    -- Shutdown
    shutdown = function() end,
}
```

## Event Catalog

All events from pi, plus smith-specific additions marked with ★.

### Resource Events
| Event | Can Block | Description |
|-------|-----------|-------------|
| `resources_discover` | No | Contribute skill/prompt/theme/theme paths |

### Session Events
| Event | Can Block | Description |
|-------|-----------|-------------|
| `session_start` | No | Session started/loaded/reloaded |
| `session_shutdown` | No | Session shutting down |
| `session_before_switch` | Yes | Before switching sessions |
| `session_before_fork` | Yes | Before forking/cloning session |
| `session_before_compact` | Yes | Before compaction, can customize |
| `session_compact` | No | Compaction completed |
| `session_tree` | No | Tree navigation completed |

### Agent Events
| Event | Can Block | Description |
|-------|-----------|-------------|
| `before_agent_start` | No | Before agent loop, can inject messages, modify system prompt |
| `agent_start` | No | Agent loop started |
| `agent_end` | No | Agent loop ended |
| `turn_start` | No | Turn started |
| `turn_end` | No | Turn ended |
| `model_select` | No | Model changed |

### Message Events
| Event | Can Block | Description |
|-------|-----------|-------------|
| `message_start` | No | Message started |
| `message_update` | No | Streaming update |
| `message_end` | No | Message completed |
| `thinking_delta` ★ | No | Streaming thinking token delta |
| `text_delta` ★ | No | Streaming text token delta |

### Tool Events
| Event | Can Block | Description |
|-------|-----------|-------------|
| `tool_execution_start` | No | Tool execution started |
| `tool_call` | **Yes** | Before tool executes, can block |
| `tool_execution_update` | No | Tool progress update |
| `tool_result` | No | After tool completes, can modify |
| `tool_execution_end` | No | Tool execution finished |

### Input Events
| Event | Can Block | Description |
|-------|-----------|-------------|
| `input` | No | User input received, can intercept/transform/handle |
| `user_bash` | No | User `!` / `!!` commands, can intercept |

### Context Events
| Event | Can Block | Description |
|-------|-----------|-------------|
| `context` | No | Before LLM call, can modify messages |
| `before_provider_request` | No | Inspect/replace provider payload |
| `after_provider_response` | No | HTTP response received |

### Plugin Events ★
| Event | Can Block | Description |
|-------|-----------|-------------|
| `plugin_loaded` | No | After a plugin finished loading |
| `plugin_unloaded` | No | Before plugin unloads |

### TUI Events ★
| Event | Can Block | Description |
|-------|-----------|-------------|
| `panel_toggle` | No | Border panel toggled (north/east/south/west) |
| `resize` | No | Terminal resized |

### Provider Events ★
| Event | Can Block | Description |
|-------|-----------|-------------|
| `provider_registered` | No | After provider added/overridden |

## Sandbox

> **Historical note.** The capability-based sandbox below was an
> early design. The canonical approach: Lua restricted runtime (no `io`, `os`,
> `debug`, `package`, `require` globals) is the *only* sandbox. No capability
> grants, no policy files, no tiers.

~~### Capabilities

```lua
-- Historical only — capability model removed. See docs/SPEC.md §9.10.
smith.request_capability("fs_read", { paths = { "./src" } })
smith.request_capability("credentials")
```~~

~~### Default Sandbox Config

```lua
-- ~/.smith/sandbox.lua — STALE, no longer used
```~~

## Built-in Plugins

Smith ships with built-in Lua plugins for default behavior:

### 1. default-layout
Default TUI layout (status bar, message list, editor, hints)

### 2. read
Read file tool

### 3. write
Write file tool

### 4. edit
Edit file tool (find-and-replace)

### 5. bash
Execute bash commands

### ~~6. compact~~
~~Context compaction~~ — removed; compaction is automatic in smith-core; see `docs/SPEC.md` §6.9.

### 7. find
Find files using `smith.fs` primitives backed by the `ignore` crate.

### 8. grep
Search file contents using ripgrep crates (`grep`, `grep-regex`,
`grep-searcher`) behind smith primitives.

### 9. commands
Registers core slash commands such as `/undo`, `/redo`, and `/history`.

### 10. time-travel
Timeline panel, state inspector, and diff views. Uses `smith.vcs.*`,
`smith.tui.*`, and `smith.shortcut.*`; no special Rust UI path.

### 11. vcs-tools
Agent-facing VCS tools (`vcs_status`, `vcs_diff`, `vcs_blame`, `vcs_log`) built
from `smith.vcs.*` primitives.

## Plugin Loading Order

1. Built-in plugins (always loaded first)
2. Global plugins (`~/.smith/plugins/`)
3. Project plugins (`.smith/plugins/`)

Later plugins override earlier ones for:
- Provider definitions
- Tool definitions
- Command definitions
- Layout (last writer wins)

## Example: Permission Gate Plugin

```lua
return function(smith)
    smith.on("tool_call", function(event, ctx)
        if event.tool_name == "bash" then
            local cmd = event.input.command
            if cmd:find("rm%s+%-rf") or cmd:find("sudo") then
                local ok = ctx.ui.confirm("Dangerous command",
                    "Allow: " .. cmd .. "?")
                if not ok then
                    return { block = true, reason = "Blocked by user" }
                end
            end
        end
    end)
end
```

## Example: Custom Provider Plugin

```lua
return function(smith)
    smith.provider.register("ollama", {
        base_url = "http://localhost:11434",
        api = "openai-completions",
        models = {
            {
                id = "llama3",
                name = "Llama 3",
                reasoning = false,
                input = { "text" },
                cost = { input = 0, output = 0, cache_read = 0, cache_write = 0 },
                context_window = 8192,
                max_tokens = 4096,
            },
        },
    })
end
```

## Example: Custom Layout Plugin

```lua
return function(smith)
    local status = smith.tui.widget.truncated_text("smith")
    local messages = smith.tui.widget.virtual_scroll()
    local editor = smith.tui.widget.editor()
    local file_tree = smith.tui.widget.select_list({})

    -- Center: messages + editor
    smith.tui.set_center_layout(
        smith.tui.layout.column({
            smith.tui.layout.widget(status),
            smith.tui.layout.expanded(
                smith.tui.layout.widget(messages)
            ),
            smith.tui.layout.widget(editor),
        })
    )

    -- West: file tree
    smith.tui.set_west_panel(
        smith.tui.layout.box({
            border = smith.tui.border.single("Files"),
            child = smith.tui.layout.widget(file_tree),
        })
    )
end
```

## TODO

- [ ] Define exact Lua type annotations
- [ ] Design plugin package distribution
- [ ] Design plugin hot-reload
- [ ] Design plugin dependency resolution
- [ ] Implement sandbox enforcement in mlua
- [ ] Design inter-plugin communication
- [ ] Design error handling for Lua plugins
