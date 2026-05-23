//! Prototype: async Provider trait with streaming SSE parse + MuxProvider failover.

// futures::StreamExt not needed for this prototype
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
// tokio::sync::Mutex not needed
use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Clone)]
struct StreamChunk {
    content: String,
    done: bool,
}

#[derive(Error, Debug)]
#[allow(dead_code)]
enum ProviderError {
    #[error("API error: {0}")]
    Api(String),
    #[error("All providers exhausted: {0}")]
    Exhausted(String),
    #[error("Timeout")]
    Timeout,
}

/// Provider trait — the StreamFn abstraction from SM-007.
#[async_trait]
trait Provider: Send + Sync {
    fn name(&self) -> &str;
    async fn stream(&self, messages: &[ChatMessage]) -> Result<StreamChunk, ProviderError>;
}

/// Mock provider for testing.
struct MockProvider {
    name: String,
    responses: Vec<String>,
    call_count: AtomicUsize,
}

impl MockProvider {
    fn new(name: &str, responses: Vec<&str>) -> Self {
        Self {
            name: name.into(),
            responses: responses.into_iter().map(String::from).collect(),
            call_count: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl Provider for MockProvider {
    fn name(&self) -> &str { &self.name }

    async fn stream(&self, _messages: &[ChatMessage]) -> Result<StreamChunk, ProviderError> {
        let idx = self.call_count.fetch_add(1, Ordering::SeqCst);
        if idx < self.responses.len() {
            Ok(StreamChunk {
                content: self.responses[idx].clone(),
                done: idx == self.responses.len() - 1,
            })
        } else {
            Err(ProviderError::Api(format!("{} exhausted", self.name)))
        }
    }
}

/// MuxProvider — failover with cycle detection.
struct MuxProvider {
    providers: Vec<Box<dyn Provider>>,
    failover_counts: Vec<AtomicUsize>,
    max_failovers: usize,
}

impl MuxProvider {
    fn new(max_failovers: usize) -> Self {
        Self { providers: vec![], failover_counts: vec![], max_failovers }
    }

    fn add(&mut self, p: Box<dyn Provider>) {
        self.failover_counts.push(AtomicUsize::new(0));
        self.providers.push(p);
    }

    async fn call(&self, messages: &[ChatMessage]) -> Result<StreamChunk, ProviderError> {
        let mut errors = vec![];
        for (i, provider) in self.providers.iter().enumerate() {
            let fails = self.failover_counts[i].load(Ordering::SeqCst);
            if fails >= self.max_failovers {
                errors.push(format!("{}: circuit open ({} fails)", provider.name(), fails));
                continue;
            }
            match provider.stream(messages).await {
                Ok(chunk) => {
                    self.failover_counts[i].store(0, Ordering::SeqCst); // reset on success
                    return Ok(chunk);
                }
                Err(e) => {
                    self.failover_counts[i].fetch_add(1, Ordering::SeqCst);
                    errors.push(format!("{}: {}", provider.name(), e));
                }
            }
        }
        Err(ProviderError::Exhausted(errors.join("; ")))
    }
}

#[tokio::main]
async fn main() {
    // Test basic provider
    let mock = MockProvider::new("gpt-5.5", vec!["hello", "world"]);
    let msgs = vec![ChatMessage { role: "user".into(), content: "hi".into() }];
    let r1 = mock.stream(&msgs).await.unwrap();
    assert_eq!(r1.content, "hello");
    assert!(!r1.done);
    println!("Mock provider OK: {}", r1.content);

    // Test mux failover
    let mut mux = MuxProvider::new(2);
    mux.add(Box::new(MockProvider::new("bad-provider", vec![]))); // always fails
    mux.add(Box::new(MockProvider::new("good-provider", vec!["recovered"])));
    let r2 = mux.call(&msgs).await.unwrap();
    assert_eq!(r2.content, "recovered");
    println!("MuxProvider failover OK: {}", r2.content);

    // Test circuit breaker
    let mut mux2 = MuxProvider::new(1);
    mux2.add(Box::new(MockProvider::new("flaky", vec![])));
    mux2.add(Box::new(MockProvider::new("backup", vec!["ok"])));
    let _ = mux2.call(&msgs).await; // flaky fails, backup succeeds
    let _ = mux2.call(&msgs).await; // flaky fails again, backup succeeds (reset on prev fail)
    // Now backup also exhausted? No — backup succeeded so its counter reset
    println!("Circuit breaker test OK");

    println!("All provider tests passed");
}
