//! Identifier newtypes (SPEC §5.1).
//!
//! Each identifier is a distinct type over `String` so that an entry id cannot
//! be passed where a session id is wanted. Generated ids are UUID v7, which is
//! time-sortable: ordering ids lexically orders them by creation, and session
//! entries therefore sort without carrying a separate sequence number.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Builds the shared body of an identifier newtype.
///
/// The four identifiers differ only in name and documentation, so the shape is
/// written once. Writing it four times over would invite the copies to drift.
macro_rules! identifier {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Generates a fresh time-sortable identifier.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7().to_string())
            }

            /// Wraps an existing identifier string.
            ///
            /// Used when reading an identifier that was generated elsewhere — a
            /// persisted session, a provider payload — where the value must be
            /// preserved exactly rather than regenerated.
            #[must_use]
            pub const fn from_string(value: String) -> Self {
                Self(value)
            }

            /// Borrows the underlying string.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// Unwraps to the owned string.
            #[must_use]
            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

identifier! {
    /// Identifies one entry within a session (SPEC §6.5).
    EntryId
}

identifier! {
    /// Identifies one session.
    SessionId
}

identifier! {
    /// Identifies one secret held by the secret proxy (SPEC §6.7).
    SecretId
}

identifier! {
    /// Identifies one recorded version-control operation (SPEC §9.13).
    VcsOpId
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "Test fixtures use unwrap so setup failures report their exact operation."
)]
mod tests {
    use super::{EntryId, SessionId};

    #[test]
    fn generated_ids_are_unique() {
        assert_ne!(EntryId::new(), EntryId::new());
    }

    #[test]
    fn generated_ids_sort_by_creation_order() {
        // UUID v7 places a millisecond timestamp in its leading bits, so
        // lexical order is creation order. Sessions rely on this to sort
        // entries without a separate sequence field.
        let mut previous = EntryId::new();
        for _ in 0..64 {
            let next = EntryId::new();
            assert!(
                previous.as_str() <= next.as_str(),
                "v7 ids must be non-decreasing: {previous} then {next}"
            );
            previous = next;
        }
    }

    #[test]
    fn an_id_survives_a_string_round_trip() {
        let id = SessionId::new();
        let restored = SessionId::from_string(id.as_str().to_owned());
        assert_eq!(id, restored);
    }

    #[test]
    fn ids_serialize_as_bare_strings() {
        // `serde(transparent)` keeps the wire form a string rather than a
        // one-field map, which is what session files and provider payloads
        // carry.
        let id = SessionId::from_string("abc".to_owned());
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"abc\"");
    }
}
