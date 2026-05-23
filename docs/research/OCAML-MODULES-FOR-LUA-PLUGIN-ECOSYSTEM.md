# OCaml Module Principles for a Lua Plugin Ecosystem

Status: research, non-canonical.
Date: 2026-05-23.

## Sources

- https://cs3110.github.io/textbook/chapters/modules/module_systems.html
- https://cs3110.github.io/textbook/chapters/modules/modules.html
- https://cs3110.github.io/textbook/chapters/modules/compilation_units.html
- https://cs3110.github.io/textbook/chapters/modules/functors.html
- https://cs3110.github.io/textbook/chapters/modules/summary.html

## Research Goal

Extract language-independent principles from OCaml modules that could help a Lua
plugin ecosystem converge on community-defined interfaces and shared modules.

The goal is not to copy OCaml syntax, type theory, or exact semantics. The goal
is to understand how a community can independently define interfaces,
implementations, adapters, and reusable module-level composition without the core
application authors predicting every future feature.

## Relevant OCaml Module Ideas

### Namespace

A module groups related names behind one namespace. Names can collide across
modules without global conflict.

Portable principle:

- plugins need explicit namespaces,
- public names should be grouped,
- importing/opening should be scoped and intentional,
- wildcard/global imports create collision risk.

### Structure

A structure is a collection of definitions: values, types, nested modules,
exceptions, etc. It is not an object. It is a named bundle of capabilities.

Portable principle:

- plugin implementations can be treated as bundles of named capabilities,
- the bundle shape matters more than the package identity,
- small focused modules make capabilities discoverable.

### Signature

A signature describes what a structure exposes. It hides implementation details
and documents the client-facing contract.

Portable principle:

- community plugin interfaces should be separate artifacts from implementations,
- interface docs belong with the interface, not duplicated in every implementation,
- consumers should target an interface, not a specific implementation,
- implementations should be checked against the interface before use.

### Signature Matching

A structure matches a signature when it provides all required names with
compatible shapes. Extra implementation details are hidden when viewed through
the signature.

Portable principle:

- interface conformance can be structural,
- implementations should be allowed to provide extra capabilities,
- consumers relying on an interface should see only that interface,
- missing or incompatible functions should fail at load/test time with useful
  diagnostics.

### Abstract Types / Representation Hiding

Interfaces can hide representation details. Clients manipulate values through
operations rather than depending on internal representation.

Portable principle:

- plugin interfaces should define opaque handles or data schemas where possible,
- consumers should not depend on implementation-private table fields,
- adapters can normalize multiple implementations behind one shared shape.

### Compilation Units: Interface and Implementation Files

OCaml separates interface (`.mli`) from implementation (`.ml`) at file level.
A missing interface exposes too much. A standalone interface without matching
implementation is a different use case and needs explicit organization.

Portable principle:

- a plugin package may be interface-only,
- a plugin package may be implementation-only,
- implementation packages need a way to declare which external interfaces they
  implement,
- interface packages need no runtime feature implementation,
- package layout must distinguish interface artifacts from implementation entry
  points.

### Functors

A functor is a module-to-module function. It takes a module matching an input
signature and returns a new module. Common uses include generating data
structures from client-provided behavior, generating shared test suites, and
extending multiple modules without copy-paste.

Portable principle:

- reusable plugin modules can be parameterized by another plugin/module that
  implements an interface,
- community test suites can target interfaces and run against any implementation,
- adapters can produce a new implementation from an old implementation,
- extensions can add behavior to every implementation of an interface without
  hard-coding concrete plugins.

### Include

Include reuses definitions from one module inside another while allowing added
or overridden definitions.

Portable principle:

- wrappers/adapters should be able to re-export a base implementation while
  adding features,
- feature composition should avoid copy-pasting entire implementations,
- conflicts and overrides need explicit rules.

## Smith-Relevant Community Problem

Example: users want subagents.

If the core application does not ship subagents, users can still build them from
primitive plugin APIs. Without a shared interface, the ecosystem can fragment:

- 20 subagent plugins,
- 20 slightly different call conventions,
- 20 incompatible state formats,
- mode/workflow/UI plugins forced to integrate with concrete implementations,
- users locked into one implementation because adjacent plugins depend on it.

An interface-module ecosystem gives a convergence path:

1. Many competing implementations appear.
2. Users and authors identify common operations.
3. A community package publishes a `subagent` interface.
4. Existing implementations add conformance declarations or adapters.
5. Other plugins target `subagent`, not a concrete implementation.
6. Users choose any compatible implementation.

Example consumers:

- mode plugins,
- workflow plugins,
- fancy subagent UI plugins,
- logging/tracing plugins,
- test/evaluation plugins.

## Desired Plugin Package Roles

### Interface-only package

Defines contract and documentation. No implementation.

Example responsibilities:

- interface name and version,
- required functions/events/data schemas,
- optional capabilities,
- behavioral docs,
- conformance tests.

### Implementation-only package

Provides concrete behavior and declares conformance to an external interface.

Example responsibilities:

- implementation module,
- manifest declaration of implemented interface,
- adapter table if public names differ,
- test command or conformance evidence.

### Interface + implementation package

Defines a contract and includes a default/reference implementation.

Useful for bootstrapping a new concept.

### Adapter package

Takes one implementation shape and exposes another interface shape.

This approximates functor-like use: module in, module out.

### Extension package

Adds behavior to any implementation of an interface.

Example: `subagent-trace-ui` depends on the `subagent` interface, not on
`alice/subagents` or `bob/agents`.

## Design Pressures for Lua

Lua lacks OCaml's static module type checker. That creates risks:

- conformance failures occur at runtime unless checked explicitly,
- docs can drift from implementation,
- table shapes are informal,
- optional fields can create accidental dialects,
- ecosystem can fragment despite shared names.

Possible mitigations:

### Runtime structural validation

Define interface descriptors as Lua data tables or JSON-like schemas. Validate
implementation modules at load time.

Pros:

- works with plain Lua,
- easy to inspect and document,
- compatible with existing mlua/LuaJIT plan,
- failures can be precise.

Cons:

- cannot prove function signatures deeply,
- behavior still requires tests,
- validation schemas can become verbose.

### Typed Lua Superset

Evaluate Teal or another typed Lua superset for interface declarations and
implementation checking.

Pros:

- closer to static module contracts,
- better editor/author feedback,
- can generate Lua.

Cons:

- adds another language/toolchain,
- may conflict with minimal LuaJIT simplicity,
- generated Lua/debugging friction,
- must prove integration with sandbox and plugin packaging.

### LuaLS/EmmyLua Annotations + Runtime Schemas

Use annotations for authoring/editor feedback and schemas for runtime validation.

Pros:

- low friction,
- good editor support,
- still plain Lua at runtime.

Cons:

- annotations are not enforcement,
- runtime schemas still required,
- two sources can drift unless generated from one descriptor.

## Candidate Interface Descriptor Shape

Plain Lua data could describe an interface:

```lua
return {
  kind = "interface",
  name = "community/subagent",
  version = "0.1.0",
  exports = {
    spawn = {
      params = {
        prompt = "string",
        model = { kind = "optional", type = "string" },
      },
      returns = "subagent.handle",
      docs = "Start a subagent task and return a handle.",
    },
    send = {
      params = {
        handle = "subagent.handle",
        message = "string",
      },
      returns = "subagent.message",
    },
  },
  events = {
    "subagent.started",
    "subagent.message",
    "subagent.finished",
  },
  tests = "tests/conformance.lua",
}
```

An implementation could declare conformance:

```lua
return {
  kind = "plugin",
  name = "alice/subagents",
  version = "0.1.0",
  implements = {
    ["community/subagent"] = {
      version = "0.1",
      module = "subagent_impl.lua",
    },
  },
  entry = "init.lua",
}
```

A consumer could require the interface, not the implementation:

```lua
local subagent = smith.interfaces.require("community/subagent")
```

The user's config chooses which implementation satisfies the interface.

## Open Design Questions

1. Is an interface descriptor plain Lua, JSON Schema, Teal, or generated from one
   source into multiple forms?
2. Are interface versions semantic versions, integer generations, or capability
   flags?
3. How does a user select an implementation when multiple plugins implement the
   same interface?
4. Can one implementation satisfy multiple interfaces?
5. Can one interface extend another?
6. Should interface packages include mandatory conformance tests?
7. Does interface validation run at install time, load time, or both?
8. How are adapters represented: implementation plugins, generated wrappers, or
   first-class module transformers?
9. How does plugin UI discover interface implementations without coupling to
   concrete plugin names?
10. How are opaque handles represented safely in plain Lua?

## Prototype Targets

### lua-interface-descriptor

Prove plain Lua interface descriptors plus runtime validation can catch missing
and malformed implementation exports.

### teal-interface-check

Evaluate Teal or another typed Lua superset for declaring interfaces and checking
implementations while still producing sandbox-compatible Lua.

### subagent-ecosystem-simulation

Create:

- two incompatible subagent implementations,
- one shared interface,
- one UI plugin targeting the interface,
- one adapter.

Verify whether a user can swap implementations without changing the UI plugin.

### conformance-test-runner

Prove interface packages can ship conformance tests that run against any selected
implementation.

## Preliminary Takeaways

- The valuable OCaml idea is not syntax; it is the separation of interface,
  implementation, conformance, opacity, and parameterized reuse.
- Plain Lua needs explicit runtime validation to approximate signature matching.
- Interface packages are likely necessary if the plugin ecosystem should
  standardize features the core app does not own.
- The subagent example is a strong test case because it requires implementations,
  consumers, UI integrations, and user-selected substitution.
