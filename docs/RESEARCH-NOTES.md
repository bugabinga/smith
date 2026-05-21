# Research Notes: smith Architecture

**Date:** 2026-04-20  
**Status:** Research complete — informs SM-004 architecture design

---

## 1. Pi SDK Architecture Analysis

### Module Structure

Pi has 4 modules in `@mariozechner/pi-coding-agent`:

| Module | Directory | Responsibility |
|--------|-----------|---------------|
| **core** | `dist/core/` | Engine: agent session, extensions, tools, providers, session management, SDK |
| **cli** | `dist/cli/` | Interface: argument parsing, session picker, config selector |
| **modes** | `dist/modes/` | Rendering: interactive mode (TUI), print mode, RPC mode |
| **utils** | `dist/utils/` | Shared: clipboard, frontmatter, shell config |

Plus a thin `main.js` that wires everything together.

### Extension System (Deep Dive)

Pi's extension system is the architectural crown jewel. Key design patterns:

**ExtensionFactory**: Entry point. A simple function `(pi: ExtensionAPI) => void`.
```typescript
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```
The extension receives an `ExtensionAPI` object and uses it to register capabilities.

**ExtensionAPI** provides 4 registration methods:
1. `registerTool()` — add LLM-callable tools
2. `registerCommand()` — add slash commands
3. `registerShortcut()` — add keyboard shortcuts
4. `registerFlag()` — add CLI flags

Plus event subscription via `on(event, handler)` for **28 event types** across the full lifecycle:
- Session lifecycle: `session_start`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_shutdown`, `session_before_tree`, `session_tree`
- Agent lifecycle: `before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`
- Message lifecycle: `message_start`, `message_update`, `message_end`
- Tool lifecycle: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_call` (can block), `tool_result` (can modify)
- Provider: `before_provider_request`, `after_provider_response`
- Context: `context` (can modify messages), `input` (can transform/handle)
- Other: `model_select`, `user_bash`, `resources_discover`

**ExtensionContext**: Passed to every event handler. Provides:
- `ui: ExtensionUIContext` — dialogs, widgets, status, custom components
- `sessionManager` (read-only)
- `modelRegistry`
- `model` (current)
- `abort()` — kill current operation
- `shutdown()` — exit pi
- `getContextUsage()` — token budget
- `compact()` — trigger compaction
- `getSystemPrompt()`

**ExtensionCommandContext** (extends ExtensionContext): Adds session mutation:
- `newSession()`, `fork()`, `navigateTree()`, `switchSession()`, `reload()`

**Key insight**: Events can **return results** that modify behavior:
- `tool_call` handlers can return `{ block: true }` to prevent execution
- `tool_result` handlers can return modified content
- `input` handlers can return `{ action: "transform", text: "..." }` to rewrite input
- `before_agent_start` can return `{ systemPrompt: "..." }` to override system prompt

**Tool System**:
```typescript
interface ToolDefinition<TParams, TDetails, TState> {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;           // TypeBox schema for LLM
    execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>;
    renderCall?(args, theme, ctx): Component;    // Custom TUI rendering
    renderResult?(result, opts, theme, ctx): Component;
    executionMode?: "sequential" | "parallel";
    promptSnippet?: string;
    promptGuidelines?: string[];
}
```

Tools have custom TUI renderers — extensions control how their tool calls and results appear in the UI.

**EventBus**: Minimal pub/sub:
```typescript
interface EventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}
```

**AgentSession**: Central coordinator. Shared across all modes (interactive, print, RPC).
- Wraps the core `Agent` from `@mariozechner/pi-agent-core`
- Manages extension runtime, tools, compaction, model switching
- Emits `AgentSessionEvent` (extends base `AgentEvent` with queue/compaction/retry events)

**SDK**: `createAgentSession(options)` — single entry point. Options include:
- `cwd`, `agentDir` (directories)
- `authStorage`, `modelRegistry`, `sessionManager`, `settingsManager` (injectable)
- `model`, `thinkingLevel`, `scopedModels` (model config)
- `tools`, `customTools` (tool config)
- `resourceLoader` (skills, prompts, themes)

Everything is injectable. The SDK uses dependency injection heavily — defaults are created if omitted.

**Loader → Runner split**:
1. `discoverAndLoadExtensions()` — finds extensions, calls factory functions, collects registrations
2. `ExtensionRunner.initialize()` — binds loaded extensions to actual session state (actions, context)
3. Extensions are loaded BEFORE the session starts, but bound AFTER

### Architecture Lessons for smith

1. **Single ExtensionFactory entry point** — simple, no class hierarchy
2. **Everything is an event** — 28 event types cover the entire lifecycle
3. **Events can mutate behavior** — not just observe, but block, transform, override
4. **Tools have custom renderers** — TUI rendering is per-tool, not global
5. **Dependency injection everywhere** — testable, replaceable
6. **Loader/Runner split** — discovery separate from binding

---

## 2. OCaml Module System — Interface/Implementation Pattern

### Core Concepts

**Module Signature (interface)** — `.mli` file:
```ocaml
module type SET = sig
  type 'a set                          (* abstract type *)
  val singleton : 'a -> 'a set
  val union : 'a set -> 'a set -> 'a set
  val of_list : 'a list -> 'a set
end
```

**Module Implementation** — `.ml` file:
```ocaml
module ListSet : SET = struct
  type 'a set = 'a list                (* concrete type hidden by sealing *)
  let singleton a = [a]
  let rec union left = function
    | [] -> left
    | x :: xs -> if List.mem x left then union left xs else union (x::left) xs
  let of_list l = union [] l
end
```

**Sealing** (`: SET`) hides implementation details. `ListSet.set` is abstract — consumers can't see it's a list.

### Key Patterns for smith

**Pattern 1: Interface-only modules (publishing contracts)**

```ocaml
(* Library A publishes an interface *)
module type TOOL_PLUGIN = sig
  type params
  type result
  val name : string
  val execute : params -> result
end
```

In Rust:
```rust
/// Published interface — other plugins implement this
pub trait ToolPlugin: Send + Sync {
    type Params: DeserializeOwned;
    type Result: Serialize;
    fn name(&self) -> &str;
    fn execute(&self, params: Self::Params) -> Result<Self::Result>;
}
```

**Pattern 2: Interface + Implementation together**

```ocaml
(* Library B provides BOTH the interface AND a reference implementation *)
module type RENDERER = sig
  type canvas
  val draw : canvas -> shape -> unit
end

module DefaultRenderer : RENDERER = struct
  type canvas = { ... }
  let draw canvas shape = ...
end
```

In Rust:
```rust
/// Interface
pub trait Renderer: Send + Sync {
    fn draw(&mut self, shape: &Shape);
}

/// Reference implementation shipped alongside the interface
pub struct DefaultRenderer { /* ... */ }
impl Renderer for DefaultRenderer { /* ... */ }
```

**Pattern 3: Multiple interfaces per module (the key pattern)**

OCaml: a module can satisfy multiple signatures:
```ocaml
module MyPlugin = struct
  (* implements SET interface *)
  type 'a set = 'a list
  let singleton a = [a]
  let union l1 l2 = ...
  
  (* also implements COMPARABLE interface *)
  type t = int
  let compare = Int.compare
end

module MyPluginAsSet : SET = MyPlugin
module MyPluginAsComparable : COMPARABLE = MyPlugin
```

In Rust — **this maps to multiple trait impls**:
```rust
pub struct MyPlugin;

impl ToolPlugin for MyPlugin {
    type Params = MyParams;
    type Result = MyResult;
    fn name(&self) -> &str { "my_tool" }
    fn execute(&self, params: Self::Params) -> Result<Self::Result> { ... }
}

impl WidgetPlugin for MyPlugin {
    fn render(&self, state: &State, area: Rect, buf: &mut Buffer) { ... }
}
```

**Pattern 4: Functors (parameterized modules)**

OCaml:
```ocaml
module type EQUALITY = sig
  type t
  val eq : t -> t -> bool
end

module SetFunctor (E : EQUALITY) : SET = struct
  type element = E.t
  type set = element list
  let singleton a = [a]
  ...
end
```

Rust equivalent — generic structs with trait bounds:
```rust
struct PluginHost<E: Equality> {
    equality: E,
    // ...
}
```

**Pattern 5: First-class modules (runtime module selection)**

OCaml:
```ocaml
let plugin = (module ListSet : SET)   (* pack module as value *)
let (module P : SET) = plugin         (* unpack *)
```

Rust equivalent — `dyn Trait`:
```rust
let plugin: Box<dyn ToolPlugin> = Box::new(MyPlugin);
```

### OCaml → Rust Mapping Summary

| OCaml Concept | Rust Equivalent | Notes |
|---------------|-----------------|-------|
| Module signature | Trait | Traits define the interface |
| Module implementation | Struct + impl Trait | Struct implements the trait |
| Sealing (`: SIG`) | Private fields + public trait | Trait exposes only interface methods |
| Abstract type (`type t`) | Associated type in trait | `type Params; type Result;` |
| Functor | Generic struct with trait bound | `struct Foo<T: Bar>` |
| First-class module | `Box<dyn Trait>` | Dynamic dispatch, runtime selection |
| Multiple interfaces | Multiple trait impls | One struct, many traits |
| `.mli` file | Trait definition in separate module | Interface module has only trait defs |

### The "Optional Interface" Pattern for smith Plugins

A plugin struct implements N traits. Not all traits are required:

```rust
/// Every plugin must implement this base trait
pub trait Plugin: Send + Sync {
    fn metadata(&self) -> &PluginMetadata;
}

/// Optional: plugin provides a tool
pub trait ToolProvider: Plugin {
    fn tool(&self) -> Box<dyn Tool>;
}

/// Optional: plugin provides a TUI widget  
pub trait WidgetProvider: Plugin {
    fn widget(&self) -> Box<dyn Widget>;
}

/// Optional: plugin provides a security policy
pub trait SecurityProvider: Plugin {
    fn policy(&self) -> Box<dyn SecurityPolicy>;
}

/// Optional: plugin provides event hooks
pub trait HookProvider: Plugin {
    fn hooks(&self) -> Vec<HookRegistration>;
}

/// Optional: plugin defines a NEW interface for others to implement
pub trait InterfacePublisher: Plugin {
    fn published_interfaces(&self) -> Vec<InterfaceDescriptor>;
}
```

The **InterfacePublisher** trait is the OCaml-inspired pattern: a plugin can publish a trait that OTHER plugins implement. The engine collects these published interfaces and makes them available for discovery.

---

## 3. Plugin Runtime Security: LuaJIT

### Architecture

LuaJIT compiles Lua → native x86/ARM machine code via JIT. Also has an interpreter fallback.

### Sandboxing Model

Lua's sandbox is **host-controlled** — the host decides exactly what enters the sandbox:
- Selectively load standard libraries via `mlua`'s `StdLib` flags
- Replace or remove any global function
- Custom `require` via `mlua-pkg` crate (composable resolver chain)
- Expose safe functionality through a custom `smith.*` Lua module

### Standard Library Configuration

| Keep | Strip | Rationale |
|------|-------|-----------|
| `string`, `table`, `math`, `coroutine`, `utf8` | `io`, `os`, `debug` | io/os give system access, debug gives reflection |
| `package` (with custom searchers) | `getfenv`, `setfenv` | package is fine with mlua-pkg replacing searchers |

Safe OS/IO operations exposed through smith's own Lua module:
```lua
smith.fs.read("path")        -- scoped to project dir, permission-gated
smith.fs.write("path", data) -- scoped, permission-gated
smith.env.get("HOME")        -- read-only env access
smith.time.now()             -- safe timestamp
```

### Custom require (mlua-pkg)

The `mlua-pkg` crate provides a composable resolver chain:

```rust
use mlua_pkg::{Registry, resolvers::*};

let mut reg = Registry::new();

// 1. Smith's API surface (Rust-native)
reg.add(NativeResolver::new().add("smith.tools", |lua| { ... }));

// 2. Sandbox to plugin's own directory
reg.add(FsResolver::new(&plugin_package_dir)?);

// 3. Embedded modules smith provides
reg.add(MemoryResolver::new().add("utils", "return { ... }"));

reg.install(&lua)?;  // Replaces package.searchers
```

This enables multi-file plugins:
```
my_plugin/
  init.lua           → require("my_plugin")
  utils.lua           → require("my_plugin.utils")
  parser/mod.lua      → require("my_plugin.parser")
  ui/layout.lua       → require("my_plugin.ui.layout")
```

Resolver scopes resolution to plugin's root. No path traversal. No native C module loading.

### Bytecode Caching (No Signing Needed)

The security invariant: **smith never loads bytecode it didn't compile itself**.

```
Plugin install:
  .lua source → stored in ~/.smith/plugins/{id}/

First load:
  Compile .lua → bytecode → cache in ~/.smith/cache/{source-hash}.luac

Subsequent loads:
  Hash source → cache hit? → load cached bytecode
  Cache miss or source changed? → recompile
```

No key management. No signing. No PKI. Security comes from:
1. Smith controls the compilation pipeline
2. Smith only loads bytecode from its own cache
3. Cache integrity verified by source content hash
4. Bytecode loading API never exposed to plugin code

If smith gets a plugin registry later, PKI goes at the distribution layer
(registry signs packages, smith verifies with embedded public key).
Local caching is orthogonal.

### Threat Analysis

**CVE-2026-40959 (Luanti)**: Host sandboxing bug, not a LuaJIT flaw. Luanti left `getfenv`
exposed. Fix: `getfenv = nil`. If the host controls what enters the sandbox,
this doesn't apply. Smith controls the sandbox.

**Bytecode injection attacks** (pwner.gg, DEFCON 9723): Requires loading untrusted
bytecode. Attack chain: crafted bytecode → UAF → type confusion → JIT-spray →
native code execution. **Eliminated by smith's model**: smith only loads bytecode
it compiled itself from trusted source. No untrusted bytecode ever enters the pipeline.

**JIT risk**: JIT generates native code, but the attack surface requires untrusted
bytecode or exposed debug/reflection APIs. With smith's sandboxing (no debug, no
untrusted bytecode, no io/os), the practical JIT attack surface is minimal.

**Resource limits**: No built-in CPU/memory limits in LuaJIT. Must be implemented
externally (watchdog threads, `debug.sethook` for instruction counting — but `debug`
is stripped). Alternative: run plugins in a separate process with OS-level resource
limits. This is a known gap to address during implementation.

### WASM (Future Option)

WASM via wasmtime is kept as a future option for:
- Stronger isolation boundary (linear memory sandbox, capability-gated I/O)
- Built-in resource limits (fuel, memory)
- Third-party untrusted plugins that need maximum sandboxing

Not included in initial architecture. Re-evaluate during the project lifetime.

---

## 4. Implications for SM-004 Architecture

### Plugin System Design

```
Plugin (base trait)
├── ToolProvider        — implements Tool trait
├── WidgetProvider      — implements Widget trait  
├── SecurityProvider    — implements SecurityPolicy trait
├── HookProvider        — subscribes to engine events
├── InterfacePublisher  — publishes new trait interfaces for others
└── CommandProvider     — registers slash commands
```

Each is optional. A plugin implements only what it needs. The engine discovers interfaces via `InterfacePublisher` and builds a registry.

### Security Architecture

```
Plugin Load → Sandbox Tier Assignment
  ├─ Tier 0 (built-in)    → Full access
  ├─ Tier 1 (trusted Lua) → Cooperative sandbox, no JIT, disabled io/os/debug
  └─ Tier 2 (WASM)        → wasmtime sandbox, capability-gated, fuel-limited

Tool Call Flow:
  LLM requests tool → SecurityPolicy.validate() → Sandbox permission check → Execute → SecurityPolicy.inspect() → Return to LLM
```

### Event System

Pi's 28-event model is excellent. smith should have a similar lifecycle event system:
- Session events (start, switch, fork, compact, shutdown)
- Agent events (before_start, start, end, turn_start, turn_end)
- Message events (start, update, end)
- Tool events (call, result, execution_start/update/end)
- Provider events (before_request, after_response)
- Input events (input — transformable/handleable)
- Plugin events (load, unload, error)

Events can return results that **mutate behavior** (block tool calls, transform input, override prompts).

### OCaml-Style Interface Publishing

```rust
/// A plugin that publishes a new interface
pub trait InterfacePublisher: Plugin {
    fn published_interfaces(&self) -> Vec<InterfaceDescriptor>;
}

pub struct InterfaceDescriptor {
    name: String,           // e.g. "output-formatter"
    schema: Schema,         // JSON schema for the interface
    rust_trait: TypeId,     // Rust trait that implementors must satisfy
}

/// Engine maintains a registry
pub struct InterfaceRegistry {
    interfaces: HashMap<String, InterfaceDescriptor>,
    implementations: HashMap<String, Vec<Box<dyn Any>>>,
}
```

This allows plugin A to define "I need things that format output" and plugin B to implement that interface, with the engine wiring them together.
