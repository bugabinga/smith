//! Identifier newtypes (SPEC §5.1).
//!
//! Each identifier is a distinct type over `String` so that an entry id cannot
//! be passed where a session id is wanted.
//!
//! Only some of them are Smith's to mint. [`EntryId`] is specified as UUID v7
//! (§5.1), which is time-sortable: ordering ids lexically orders them by
//! creation, so session entries sort without a separate sequence number, and
//! [`SessionId`] is generated the same way. [`SecretId`] and [`VcsOpId`] have
//! no constructor here on purpose — a secret id is allocated numerically by the
//! secret proxy, which resumes past the highest id it has seen (§6.7), and a
//! VCS operation id names an operation the VCS performed (§9.13). Inventing
//! either here would produce a value the owning subsystem cannot honor.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Builds the shared body of an identifier newtype.
///
/// The identifiers differ only in name and documentation, so the shape is
/// written once rather than four times over, where the copies could drift.
macro_rules! identifier {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Wraps an existing identifier string.
            ///
            /// Used when reading an identifier generated elsewhere — a
            /// persisted session, a provider payload, the VCS — where the value
            /// must be preserved exactly rather than regenerated.
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

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

/// Builds an identifier that Smith mints itself, as UUID v7.
macro_rules! generated_identifier {
    ($(#[$meta:meta])* $name:ident) => {
        identifier! { $(#[$meta])* $name }

        impl $name {
            /// Generates a fresh time-sortable identifier.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7().to_string())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
    };
}

generated_identifier! {
    /// Identifies one entry within a session (SPEC §6.5).
    EntryId
}

generated_identifier! {
    /// Identifies one session.
    SessionId
}

identifier! {
    /// Identifies one secret held by the secret proxy (SPEC §6.7).
    ///
    /// Allocated by the proxy as a number, rendered in content as a
    /// `smith:sec:<digits>` placeholder; on resume the allocator continues past
    /// the highest id seen, because a reused id silently aliases older
    /// placeholders. That allocator owns minting, so this type only carries a
    /// value it was given.
    SecretId
}

identifier! {
    /// Identifies one recorded version-control operation (SPEC §9.13).
    ///
    /// Names an operation the VCS performed, so the VCS supplies the value.
    VcsOpId
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "Test fixtures use unwrap so setup failures report their exact operation."
)]
mod tests {
    use super::{EntryId, SecretId, SessionId};

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
    fn a_secret_id_carries_the_allocator_s_value_verbatim() {
        // The proxy allocates numerically and content carries
        // `smith:sec:<digits>` (§6.7), so this type must not reshape what it is
        // handed — a placeholder id parses as the maximal digit run.
        let id = SecretId::from_string("12".to_owned());
        assert_eq!(id.as_str(), "12");
        assert_eq!(format!("smith:sec:{id}"), "smith:sec:12");
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
