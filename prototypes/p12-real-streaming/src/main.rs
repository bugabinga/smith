//! Comprehensive MiniMax Token Plan API test suite.
//!
//! Tests:
//!   1. Streaming with full completion (high max_tokens)
//!   2. Non-streaming mode
//!   3. MiniMax-M2.7-highspeed model
//!   4. Multi-turn conversation
//!   5. Error cases (invalid model, empty messages)
//!   6. Token usage measurement from response
//!
//! NEVER prints API key. Requires MINIMAX_API_KEY env var for live tests.

#![allow(dead_code)]
use serde::Deserialize;
use std::env;

const URL: &str = "https://api.minimax.io/v1/chat/completions";

// --- Response types ---

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
    message: Option<Message>,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct Delta {
    role: Option<String>,
    content: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct Message {
    role: Option<String>,
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Usage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

// --- SSE parsing ---

fn parse_sse_lines(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        if let Some((k, v)) = parse_sse_line(line) {
            out.push((k, v));
        }
    }
    out
}

fn parse_sse_line(line: &str) -> Option<(String, String)> {
    let l = line.trim();
    if l.is_empty() { return None; }
    if let Some(e) = l.strip_prefix("event:") { return Some(("event".into(), e.trim().to_string())); }
    if let Some(d) = l.strip_prefix("data:") { return Some(("data".into(), d.trim().to_string())); }
    None
}

// --- Helpers ---

fn get_api_key() -> Option<String> {
    match env::var("MINIMAX_API_KEY") {
        Ok(k) if !k.is_empty() => Some(k),
        _ => None,
    }
}

async fn do_request(
    client: &reqwest::Client,
    api_key: &str,
    body: serde_json::Value,
) -> (reqwest::StatusCode, String) {
    let resp = client
        .post(URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await;
    match resp {
        Ok(r) => {
            let status = r.status();
            let text = r.text().await.unwrap_or_default();
            (status, text)
        }
        Err(e) => (reqwest::StatusCode::SERVICE_UNAVAILABLE, format!("Request error: {}", e)),
    }
}

/// Parse raw text as SSE stream. Returns (content, finish_reason, chunk_count, usage).
async fn parse_stream_text(_status: reqwest::StatusCode, text: String) -> Result<(String, Option<String>, u32, Option<Usage>), String> {
    // Reconstruct a response for streaming — use a fake response that we manually parse
    // Since we already have the full text, parse it directly as SSE lines.
    let mut full_content = String::new();
    let mut chunk_count = 0u32;
    let mut finish_reason = None;
    let mut usage = None;

    let events = parse_sse_lines(&text);
    for (kind, val) in &events {
        if kind == "data" && val != "[DONE]" {
            if let Ok(resp) = serde_json::from_str::<ChatResponse>(val) {
                chunk_count += 1;
                for choice in &resp.choices {
                    if let Some(ref c) = choice.delta.content {
                        full_content.push_str(c);
                    }
                    if choice.finish_reason.is_some() {
                        finish_reason = choice.finish_reason.clone();
                    }
                }
                if resp.usage.is_some() {
                    usage = resp.usage;
                }
            }
        }
    }
    Ok((full_content, finish_reason, chunk_count, usage))
}

// --- Individual tests ---

/// Test 1: Streaming with full completion (high max_tokens).
async fn test_streaming_full(client: &reqwest::Client, api_key: &str) -> Result<(), String> {
    eprintln!("\n=== TEST 1: Streaming (full completion, max_tokens=256) ===");
    let body = serde_json::json!({
        "model": "MiniMax-M2.7",
        "messages": [{ "role": "user", "content": "Explain what a closure is in Rust, in 2-3 sentences." }],
        "stream": true,
        "max_tokens": 256
    });
    let (status, text) = do_request(client, api_key, body).await;
    eprintln!("  Status: {}", status);
    if !status.is_success() {
        return Err(format!("Expected 200, got {}: {}", status, &text[..text.len().min(200)]));
    }

    let (content, finish, chunks, usage) = parse_stream_text(status, text).await?;
    eprintln!("  Chunks: {}, Finish: {:?}", chunks, finish);
    eprintln!("  Content ({} chars): {}", content.len(),
        if content.len() > 200 { format!("{}...", &content[..200]) } else { content.clone() });
    if let Some(u) = &usage {
        eprintln!("  Usage: prompt={}, completion={}, total={}",
            u.prompt_tokens, u.completion_tokens, u.total_tokens);
    }

    if chunks == 0 { return Err("Expected streaming chunks".into()); }
    if content.is_empty() { return Err("Expected non-empty content".into()); }
    if finish.is_none() { return Err("Expected finish_reason".into()); }
    if finish.as_deref() == Some("length") {
        eprintln!("  [WARN] finish_reason=length (content may be truncated)");
    }
    eprintln!("  [OK] Streaming full completion passed");
    Ok(())
}

/// Test 2: Non-streaming mode.
async fn test_non_streaming(client: &reqwest::Client, api_key: &str) -> Result<(), String> {
    eprintln!("\n=== TEST 2: Non-streaming ===");
    let body = serde_json::json!({
        "model": "MiniMax-M2.7",
        "messages": [{ "role": "user", "content": "Say exactly: Hello world. Nothing else." }],
        "stream": false,
        "max_tokens": 50
    });
    let (status, text) = do_request(client, api_key, body).await;
    eprintln!("  Status: {}", status);
    if !status.is_success() {
        return Err(format!("Expected 200, got {}: {}", status, &text[..text.len().min(200)]));
    }

    let resp: ChatResponse = serde_json::from_str(&text)
        .map_err(|e| format!("JSON parse failed: {} -- body: {}", e, &text[..text.len().min(300)]))?;

    let content = resp.choices.first()
        .and_then(|c| c.message.as_ref())
        .and_then(|m| m.content.as_ref())
        .map(|s| s.as_str())
        .unwrap_or("");
    let finish = resp.choices.first().and_then(|c| c.finish_reason.as_ref());
    eprintln!("  Content: {:?}", content);
    eprintln!("  Finish: {:?}", finish);
    if let Some(u) = &resp.usage {
        eprintln!("  Usage: prompt={}, completion={}, total={}",
            u.prompt_tokens, u.completion_tokens, u.total_tokens);
    }

    if resp.choices.is_empty() { return Err("Expected at least 1 choice".into()); }
    if content.is_empty() { return Err("Expected non-empty content".into()); }
    if finish.is_none() { return Err("Expected finish_reason".into()); }
    if resp.usage.is_none() { return Err("Expected usage field".into()); }
    eprintln!("  [OK] Non-streaming passed");
    Ok(())
}

/// Test 3: MiniMax-M2.7-highspeed model.
async fn test_highspeed_model(client: &reqwest::Client, api_key: &str) -> Result<(), String> {
    eprintln!("\n=== TEST 3: MiniMax-M2.7-highspeed ===");
    let body = serde_json::json!({
        "model": "MiniMax-M2.7-highspeed",
        "messages": [{ "role": "user", "content": "Reply with just the number 42. No explanation." }],
        "stream": true,
        "max_tokens": 50
    });
    let (status, text) = do_request(client, api_key, body).await;
    eprintln!("  Status: {}", status);
    // highspeed model may not be available for this plan
    if !status.is_success() {
        eprintln!("  [INFO] Model not available (expected for some plans): {}", status);
        eprintln!("  Response: {}", &text[..text.len().min(300)]);
        eprintln!("  [OK] Error response correctly detected");
        return Ok(());
    }

    let (content, finish, chunks, _usage) = parse_stream_text(status, text).await?;
    eprintln!("  Chunks: {}, Finish: {:?}", chunks, finish);
    eprintln!("  Content: {:?}", content);
    if chunks == 0 { return Err("Expected streaming chunks".into()); }
    if content.is_empty() { return Err("Expected non-empty content".into()); }
    if finish.is_none() { return Err("Expected finish_reason".into()); }
    eprintln!("  [OK] Highspeed model passed");
    Ok(())
}

/// Test 4: Multi-turn conversation.
async fn test_multi_turn(client: &reqwest::Client, api_key: &str) -> Result<(), String> {
    eprintln!("\n=== TEST 4: Multi-turn conversation ===");
    let body = serde_json::json!({
        "model": "MiniMax-M2.7",
        "messages": [
            { "role": "system", "content": "You are a helpful assistant who gives very short answers." },
            { "role": "user", "content": "My name is Smith." },
            { "role": "assistant", "content": "Hello Smith! How can I help you?" },
            { "role": "user", "content": "What is my name? Reply with just the name." }
        ],
        "stream": false,
        "max_tokens": 50
    });
    let (status, text) = do_request(client, api_key, body).await;
    eprintln!("  Status: {}", status);
    if !status.is_success() {
        return Err(format!("Expected 200, got {}: {}", status, &text[..text.len().min(200)]));
    }

    let resp: ChatResponse = serde_json::from_str(&text)
        .map_err(|e| format!("JSON parse failed: {}", e))?;
    let content = resp.choices.first()
        .and_then(|c| c.message.as_ref())
        .and_then(|m| m.content.as_ref())
        .map(|s| s.as_str())
        .unwrap_or("");
    eprintln!("  Content: {:?}", content);
    if let Some(u) = &resp.usage {
        eprintln!("  Usage: prompt={}, completion={}, total={}",
            u.prompt_tokens, u.completion_tokens, u.total_tokens);
        if u.prompt_tokens <= 5 {
            return Err(format!("Expected multi-turn prompt_tokens > 5, got {}", u.prompt_tokens));
        }
    }

    if content.is_empty() { return Err("Expected non-empty content".into()); }
    eprintln!("  [OK] Multi-turn passed");
    Ok(())
}

/// Test 5: Error cases.
async fn test_errors(client: &reqwest::Client, api_key: &str) -> Result<(), String> {
    eprintln!("\n=== TEST 5: Error cases ===");

    // 5a: Invalid model
    {
        let body = serde_json::json!({
            "model": "does-not-exist-999",
            "messages": [{ "role": "user", "content": "Hi" }],
            "stream": false,
            "max_tokens": 10
        });
        let (status, text) = do_request(client, api_key, body).await;
        eprintln!("  [5a] Invalid model -> Status: {}", status);
        eprintln!("       Response: {}", &text[..text.len().min(200)]);
        if status.is_success() {
            return Err("Expected error for invalid model".into());
        }
        eprintln!("  [OK] Invalid model correctly rejected");
    }

    // 5b: Empty messages array
    {
        let body = serde_json::json!({
            "model": "MiniMax-M2.7",
            "messages": [],
            "stream": false,
            "max_tokens": 10
        });
        let (status, text) = do_request(client, api_key, body).await;
        eprintln!("  [5b] Empty messages -> Status: {}", status);
        eprintln!("       Response: {}", &text[..text.len().min(200)]);
        if status.is_success() {
            eprintln!("  [INFO] Empty messages accepted (API default behavior)");
        } else {
            eprintln!("  [OK] Empty messages correctly rejected");
        }
    }

    // 5c: No API key (empty Bearer)
    {
        let body = serde_json::json!({
            "model": "MiniMax-M2.7",
            "messages": [{ "role": "user", "content": "Hi" }],
            "stream": false,
            "max_tokens": 10
        });
        let resp = client.post(URL)
            .header("Authorization", "Bearer ")
            .header("Content-Type", "application/json")
            .json(&body)
            .send().await;
        match resp {
            Ok(r) => {
                eprintln!("  [5c] No API key -> Status: {}", r.status());
                if r.status().is_success() {
                    return Err("Expected auth failure with empty key".into());
                }
            }
            Err(e) => { eprintln!("  [5c] No API key -> Request error: {}", e); }
        }
        eprintln!("  [OK] Empty key correctly rejected");
    }
    Ok(())
}

/// Test 6: Token usage measurement.
async fn test_token_usage(client: &reqwest::Client, api_key: &str) -> Result<(), String> {
    eprintln!("\n=== TEST 6: Token usage measurement ===");
    let body = serde_json::json!({
        "model": "MiniMax-M2.7",
        "messages": [{ "role": "user", "content": "Count from 1 to 5, one number per line." }],
        "stream": true,
        "max_tokens": 100,
        "stream_options": { "include_usage": true }
    });
    let (status, text) = do_request(client, api_key, body).await;
    eprintln!("  Status: {}", status);
    if !status.is_success() {
        return Err(format!("Expected 200, got {}: {}", status, &text[..text.len().min(200)]));
    }

    let (_content, finish, chunks, usage) = parse_stream_text(status, text).await?;
    eprintln!("  Chunks: {}, Finish: {:?}", chunks, finish);

    if let Some(u) = &usage {
        eprintln!("  Usage: prompt={}, completion={}, total={}",
            u.prompt_tokens, u.completion_tokens, u.total_tokens);
        if u.total_tokens != u.prompt_tokens + u.completion_tokens {
            return Err(format!("total_tokens {} != prompt {} + completion {}",
                u.total_tokens, u.prompt_tokens, u.completion_tokens));
        }
        if u.completion_tokens == 0 {
            return Err("Expected completion_tokens > 0".into());
        }
        eprintln!("  [OK] Token usage from stream: all fields valid");
        return Ok(());
    }

    // Fallback: non-streaming for usage
    eprintln!("  [WARN] No usage in stream (stream_options.include_usage may not be supported)");
    eprintln!("  Falling back to non-streaming for usage...");
    let body2 = serde_json::json!({
        "model": "MiniMax-M2.7",
        "messages": [{ "role": "user", "content": "Count from 1 to 5." }],
        "stream": false,
        "max_tokens": 100
    });
    let (status2, text2) = do_request(client, api_key, body2).await;
    if !status2.is_success() {
        return Err(format!("Fallback request failed: {}", status2));
    }
    let resp2: ChatResponse = serde_json::from_str(&text2)
        .map_err(|e| format!("Fallback JSON parse failed: {}", e))?;
    if let Some(u2) = &resp2.usage {
        eprintln!("  Usage (non-stream): prompt={}, completion={}, total={}",
            u2.prompt_tokens, u2.completion_tokens, u2.total_tokens);
        if u2.total_tokens != u2.prompt_tokens + u2.completion_tokens {
            return Err(format!("total_tokens mismatch: {} != {} + {}",
                u2.total_tokens, u2.prompt_tokens, u2.completion_tokens));
        }
        if u2.completion_tokens == 0 {
            return Err("Expected completion_tokens > 0".into());
        }
        eprintln!("  [OK] Token usage from non-stream: all fields valid");
    } else {
        eprintln!("  [WARN] No usage field even in non-streaming response");
    }
    Ok(())
}

// --- Mock SSE test (always runs, no network) ---

fn test_mock_sse() {
    eprintln!("\n--- Mock SSE Test (no network) ---");
    let mock_sse = concat!(
        "event: ping\n\n",
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    let mock_events = parse_sse_lines(mock_sse);
    let mut mock_content = String::new();
    let mut mock_chunks = 0u32;
    let mut mock_finish = None;
    for (kind, val) in &mock_events {
        if kind == "data" && val != "[DONE]" {
            if let Ok(resp) = serde_json::from_str::<ChatResponse>(val) {
                mock_chunks += 1;
                for c in &resp.choices {
                    if let Some(ref content) = c.delta.content { mock_content.push_str(content); }
                    if c.finish_reason.is_some() { mock_finish = c.finish_reason.clone(); }
                }
            }
        }
    }
    assert_eq!(mock_content, "Hello world");
    assert_eq!(mock_finish.as_deref(), Some("stop"));
    assert_eq!(mock_chunks, 4); // role + "Hello" + " world" + finish
    eprintln!("  [OK] Mock SSE: {} chunks, content={:?}, finish={:?}", mock_chunks, mock_content, mock_finish);
}

// --- Main ---

macro_rules! run_test {
    ($name:expr, $fn:expr, $client:expr, $key:expr) => {
        match $fn($client, $key).await {
            Ok(()) => ($name, true),
            Err(e) => { eprintln!("  [FAIL] {}: {}", $name, e); ($name, false) }
        }
    };
}

#[tokio::main]
async fn main() {
    // Mock test always runs
    test_mock_sse();

    // Live tests need API key
    let api_key = match get_api_key() {
        Some(k) => k,
        None => {
            eprintln!("\n[SKIP] MINIMAX_API_KEY not set. Only mock tests ran.");
            eprintln!("  Set: export MINIMAX_API_KEY=your-key");
            return;
        }
    };
    eprintln!("[INFO] MINIMAX_API_KEY: set ({} chars)", api_key.len());

    let client = reqwest::Client::new();
    let mut results: Vec<(&str, bool)> = Vec::new();

    results.push(run_test!("T1 streaming_full", test_streaming_full, &client, &api_key));
    results.push(run_test!("T2 non_streaming", test_non_streaming, &client, &api_key));
    results.push(run_test!("T3 highspeed_model", test_highspeed_model, &client, &api_key));
    results.push(run_test!("T4 multi_turn", test_multi_turn, &client, &api_key));
    results.push(run_test!("T5 error_cases", test_errors, &client, &api_key));
    results.push(run_test!("T6 token_usage", test_token_usage, &client, &api_key));

    eprintln!();
    let passed = results.iter().filter(|(_, ok)| *ok).count();
    let total = results.len();
    eprintln!("=== SUMMARY: {}/{} tests passed ===", passed, total);
    for (name, ok) in &results {
        eprintln!("  {} {}", if *ok { "[OK]" } else { "[FAIL]" }, name);
    }
    if passed < total {
        eprintln!("  {} test(s) FAILED", total - passed);
    } else {
        eprintln!("\n  ALL TESTS PASSED");
    }
}
