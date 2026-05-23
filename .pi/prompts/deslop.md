---
description: Delegate LLM-generated Rust cleanup to the project deslopper agent
argument-hint: <code area or patch to deslop>
---
Use the `flow` tool.

Parameters:
- agent: `deslopper`
- agentScope: `project`
- confirmProjectAgents: true

Delegate this task verbatim:

$@

Return the deslopper JSON result, including risks and tests.
