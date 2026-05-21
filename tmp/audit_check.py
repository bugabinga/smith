import json

issues = []

# SM-004 issues
issues.append({
    "id": "AUDIT-001",
    "severity": "P1",
    "file": "docs/spec-sm-004-architecture.md",
    "line": "181",
    "issue": "SM-004 defines struct SessionEntry { type_: String, id: String, timestamp: u64, payload: Vec<u8> } which contradicts SM-006's pub enum SessionEntry with variants like Session, User, Assistant, etc.",
    "evidence": "Line 181: struct SessionEntry vs SM-006 line 249: pub enum SessionEntry"
})

issues.append({
    "id": "AUDIT-002",
    "severity": "P1",
    "file": "docs/spec-sm-004-architecture.md",
    "line": "230",
    "issue": "SM-004 uses enum variant syntax SessionEntry::Session { version, .. } on a struct defined at line 181. Self-contradictory.",
    "evidence": "Line 230: match e { SessionEntry::Session { version, .. } => ... } but line 181 defines struct SessionEntry, not enum"
})

# SM-009 issues
issues.append({
    "id": "AUDIT-003",
    "severity": "P2",
    "file": "docs/spec-sm-009-harness.md",
    "line": "164",
    "issue": "dispatch_event only handles PluginEvent::ToolCall and silently ignores all other PluginEvent variants. Non-tool event handlers never fire.",
    "evidence": "Lines 164-170: only 'if let PluginEvent::ToolCall { ... } = event' branch exists; no else branch or other event dispatching"
})

issues.append({
    "id": "AUDIT-004",
    "severity": "P2",
    "file": "docs/spec-sm-009-harness.md",
    "line": "142",
    "issue": "agent_event_to_plugin_event has incomplete match arms with '// ... etc' comment. Mapping undefined for AgentEnd, TurnEnd, MessageUpdate, MessageEnd, ToolExecutionEnd, ToolExecutionUpdate, TextDelta, ThinkingDelta, Error.",
    "evidence": "Line 150: '// ... etc' instead of exhaustive match arms for all AgentEvent variants"
})

issues.append({
    "id": "AUDIT-005",
    "severity": "P2",
    "file": "docs/spec-sm-009-harness.md",
    "line": "118",
    "issue": "PluginEvent enum missing ToolExecutionUpdate variant to correspond with AgentEvent::ToolExecutionUpdate from SM-006.",
    "evidence": "PluginEvent variants listed at line 118: AgentStart, AgentEnd, TurnStart, TurnEnd, MessageStart, MessageUpdate, MessageEnd, ToolExecutionStart, ToolExecutionEnd, ToolCall, TextDelta, ThinkingDelta, Error — no ToolExecutionUpdate"
})

issues.append({
    "id": "AUDIT-006",
    "severity": "P2",
    "file": "docs/spec-sm-009-harness.md",
    "line": "167",
    "issue": "dispatch_event passes only tool_call_id and tool_name to Lua handlers, not the input args. Plugins cannot inspect tool arguments to make informed blocking decisions.",
    "evidence": "Line 167: lua.call_function(handler.clone(), (tool_call_id, tool_name)) — missing input/args parameter"
})

# SM-008 issues
issues.append({
    "id": "AUDIT-007",
    "severity": "P2",
    "file": "docs/spec-sm-008-tui.md",
    "line": "257",
    "issue": "dispatch_event calls widget.as_any_mut() but Component trait (line 152) does not define fn as_any_mut. Code will not compile.",
    "evidence": "Line 257: widget.as_any_mut().downcast_mut::<dyn Focusable>() — Component trait at line 152 has render, handle_event, invalidate only"
})

issues.append({
    "id": "AUDIT-008",
    "severity": "P3",
    "file": "docs/spec-sm-009-harness.md",
    "line": "308",
    "issue": "Bash security comment says 'If any event handler returns Block' which is vague. Lua handlers don't return a 'Block' value; they error via mlua::Error which gets converted to BlockReason::BlockedByPlugin.",
    "evidence": "Line 308: 'returns Block' vs actual mechanism at line 169: Err(BlockReason::BlockedByPlugin(e.to_string()))"
})

print(json.dumps({"issues_found": len(issues), "issues": issues}, indent=2))
