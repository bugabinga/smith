//! The provider abstraction the agent loop consumes (SPEC §5.4).

use std::sync::Arc;

use futures::stream::BoxStream;

use crate::provider::{ProviderEvent, ProviderRequest};

/// Turns a request into a stream of provider events.
///
/// This is the whole of what `smith-core` knows about providers: a function
/// from [`ProviderRequest`] to an async stream of [`ProviderEvent`]. It names
/// no provider and does not depend on `smith-ai`, which is what lets the two
/// crates build and be tested independently — and what lets the walking
/// skeleton run its agent loop against a scripted stream with no network.
///
/// It is an `Arc` because the loop shares one provider across tasks, and
/// `Send + Sync` for the same reason. The returned stream is `'static` so it
/// can outlive the call that produced it.
pub type StreamFn = Arc<dyn Fn(ProviderRequest) -> BoxStream<'static, ProviderEvent> + Send + Sync>;

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::StreamExt as _;

    use super::StreamFn;
    use crate::message::{Message, Role};
    use crate::provider::{ProviderEvent, ProviderRequest, ProviderUsage, StopReason};

    #[test]
    fn a_scripted_stream_satisfies_the_alias() {
        // This is the shape SM-007 supplies for the walking skeleton: a fixture
        // sequence replayed with no network. If a scripted function cannot
        // satisfy the alias, the hermetic end-to-end test has nothing to run
        // against.
        let script = vec![
            ProviderEvent::TextDelta {
                text: "hello".to_owned(),
            },
            ProviderEvent::Done {
                usage: ProviderUsage::default(),
                stop_reason: StopReason::EndTurn,
            },
        ];

        let stream_fn: StreamFn = Arc::new(move |_request: ProviderRequest| {
            futures::stream::iter(script.clone()).boxed()
        });

        let request =
            ProviderRequest::new("scripted", "fixture", vec![Message::text(Role::User, "hi")]);
        let events: Vec<ProviderEvent> = futures::executor::block_on(stream_fn(request).collect());

        assert_eq!(events.len(), 2);
        assert!(matches!(events[1], ProviderEvent::Done { .. }));
    }
}
