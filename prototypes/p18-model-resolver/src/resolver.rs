//! Pure model resolution graph (SPEC §5.7).
//!
//! PURITY BY CONSTRUCTION: this module's only imports are
//! `std::collections::BTreeMap`, `std::fmt`, and `serde::Deserialize`.
//! There is no `std::fs`, `std::net`, `std::io`, `std::process`,
//! `std::env`, or `std::time` anywhere in this file — the `resolve`
//! scenario in `main.rs` scans this source (via `include_str!`) and
//! fails if any such import appears.
//!
//! ROUND-ROBIN STATE: §5.7 says the resolver is pure AND groups may use a
//! round-robin failover strategy. Rotation is inherently stateful, so the
//! state cannot live here. The split proven by this prototype:
//! `resolve(requested, &Cursors)` is a pure function of (validated config,
//! requested name, caller-supplied rotation cursors). The caller — Mux
//! (§7.5) — owns the `Cursors` map and advances the cursor of every
//! rotation node reported in `Resolution::rotation_nodes` after each
//! provider request. Same config + same cursors => same plan, always.
//!
//! EDGE RULES chosen where §5.7 is silent (all rejected AT LOAD, so
//! resolve-time never sees a malformed graph):
//! - name shadowing (same name defined as more than one kind): load error,
//! - empty group / empty bucket account list: load error,
//! - reference to an undefined name (alias target, group member): load error,
//! - duplicate name inside one group member list: load error (ambiguous —
//!   could mean weighting; the spec must pin a meaning before allowing it),
//! - bucket `model` must name a concrete model (not an alias/group): load
//!   error otherwise,
//! - cycles (alias→alias, group⊃group transitively, mixed): load error
//!   carrying the full cycle path; DAG sharing is NOT a cycle.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::fmt;

// ---- config-side types (SPEC §5.7) ----

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ModelMetadata {
    pub context_window: u64,
    pub max_output_tokens: u64,
    pub input_cost_per_mtok: f64,
    pub output_cost_per_mtok: f64,
    pub thinking: bool,
    pub vision: bool,
    pub tool_use: bool,
    pub streaming: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelDef {
    pub provider: String,
    pub model: String,
    pub metadata: ModelMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailoverStrategy {
    Ordered,
    RoundRobin,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupDef {
    pub strategy: FailoverStrategy,
    pub members: Vec<String>,
}

/// §5.7 `BucketStrategy`: account rotation policy.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BucketStrategy {
    /// Rotate the starting account across requests (stateful; cursor
    /// lives with the caller, like group round-robin).
    RoundRobin,
    /// Always start from the first account; later accounts are reached
    /// only by failover within one request.
    Sticky,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BucketDef {
    /// Must name a concrete model (validated at load).
    pub model: String,
    pub strategy: BucketStrategy,
    pub accounts: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub aliases: BTreeMap<String, String>,
    #[serde(default)]
    pub groups: BTreeMap<String, GroupDef>,
    #[serde(default)]
    pub buckets: BTreeMap<String, BucketDef>,
    #[serde(default)]
    pub models: BTreeMap<String, ModelDef>,
}

// ---- load-time errors ----

#[derive(Debug, PartialEq)]
pub enum LoadError {
    /// Same name defined as more than one kind (alias/group/bucket/model).
    Shadowed { name: String, kinds: Vec<&'static str> },
    EmptyGroup { group: String },
    EmptyBucket { bucket: String },
    /// A name appears more than once in a single group's member list.
    DuplicateMember { group: String, member: String },
    /// An alias target or group member names nothing that exists.
    UnknownReference { referrer: String, missing: String },
    /// A bucket's `model` field names something that is not a concrete model.
    BucketModelNotConcrete { bucket: String, target: String },
    /// Reference cycle; `path` is the full cycle, first == last.
    Cycle { path: Vec<String> },
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LoadError::Shadowed { name, kinds } => write!(
                f,
                "name '{name}' defined as more than one kind: {} (shadowing rejected at load)",
                kinds.join(", ")
            ),
            LoadError::EmptyGroup { group } => {
                write!(f, "group '{group}' has no members (rejected at load)")
            }
            LoadError::EmptyBucket { bucket } => {
                write!(f, "bucket '{bucket}' has no accounts (rejected at load)")
            }
            LoadError::DuplicateMember { group, member } => write!(
                f,
                "group '{group}' lists member '{member}' more than once (rejected at load)"
            ),
            LoadError::UnknownReference { referrer, missing } => {
                write!(f, "{referrer} references unknown name '{missing}'")
            }
            LoadError::BucketModelNotConcrete { bucket, target } => write!(
                f,
                "bucket '{bucket}' must reference a concrete model, '{target}' is not one"
            ),
            LoadError::Cycle { path } => {
                write!(f, "cycle detected at config load: {}", path.join(" -> "))
            }
        }
    }
}

// ---- resolution-side types ----

/// One concrete attempt target handed to Mux, in failover order.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub provider: String,
    pub model: String,
    pub account: Option<String>,
    pub metadata: ModelMetadata,
}

impl Candidate {
    pub fn label(&self) -> String {
        match &self.account {
            Some(a) => format!("{}@{}", self.model, a),
            None => self.model.clone(),
        }
    }
}

/// The ResolvedModel plan: ordered candidates plus the names of the
/// round-robin nodes whose cursors the caller must advance after use.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolution {
    pub requested: String,
    pub candidates: Vec<Candidate>,
    pub rotation_nodes: Vec<String>,
}

/// Rotation cursors, owned by the caller (Mux). Keyed by group/bucket name.
pub type Cursors = BTreeMap<String, u64>;

#[derive(Debug, PartialEq)]
pub enum ResolveError {
    UnknownName(String),
}

impl fmt::Display for ResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ResolveError::UnknownName(n) => write!(f, "unknown model name '{n}'"),
        }
    }
}

// ---- the resolver ----

#[derive(Debug)]
pub struct Resolver {
    cfg: Config, // private: a Resolver only exists for a load-validated config
}

impl Resolver {
    /// Validate the whole graph. Every structural defect — shadowing,
    /// empty groups/buckets, dangling references, duplicates, cycles —
    /// is a load error; `resolve` can then never fail structurally.
    pub fn load(cfg: Config) -> Result<Resolver, LoadError> {
        // 1. name shadowing across kinds.
        let mut all_names: Vec<&String> = Vec::new();
        all_names.extend(cfg.aliases.keys());
        all_names.extend(cfg.groups.keys());
        all_names.extend(cfg.buckets.keys());
        all_names.extend(cfg.models.keys());
        all_names.sort();
        all_names.dedup();
        for name in &all_names {
            let kinds = kinds_of(&cfg, name);
            if kinds.len() > 1 {
                return Err(LoadError::Shadowed { name: (*name).clone(), kinds });
            }
        }

        // 2. per-node shape checks.
        for (gname, g) in &cfg.groups {
            if g.members.is_empty() {
                return Err(LoadError::EmptyGroup { group: gname.clone() });
            }
            for (i, m) in g.members.iter().enumerate() {
                if g.members[..i].contains(m) {
                    return Err(LoadError::DuplicateMember {
                        group: gname.clone(),
                        member: m.clone(),
                    });
                }
            }
        }
        for (bname, b) in &cfg.buckets {
            if b.accounts.is_empty() {
                return Err(LoadError::EmptyBucket { bucket: bname.clone() });
            }
            if !cfg.models.contains_key(&b.model) {
                return Err(LoadError::BucketModelNotConcrete {
                    bucket: bname.clone(),
                    target: b.model.clone(),
                });
            }
        }

        // 3. dangling references.
        let defined = |n: &str| !kinds_of(&cfg, n).is_empty();
        for (aname, target) in &cfg.aliases {
            if !defined(target) {
                return Err(LoadError::UnknownReference {
                    referrer: format!("alias '{aname}'"),
                    missing: target.clone(),
                });
            }
        }
        for (gname, g) in &cfg.groups {
            for m in &g.members {
                if !defined(m) {
                    return Err(LoadError::UnknownReference {
                        referrer: format!("group '{gname}'"),
                        missing: m.clone(),
                    });
                }
            }
        }

        // 4. cycles, with full path. DFS with Visiting/Done coloring:
        // Done nodes are never re-entered, so shared DAG nodes cannot
        // false-positive.
        check_cycles(&cfg)?;

        Ok(Resolver { cfg })
    }

    /// Pure resolution: requested name -> alias* -> group* -> bucket/account
    /// -> concrete provider/model candidates, flattened in the exact order
    /// Mux must attempt them. Reads only `self.cfg` and `cursors`.
    pub fn resolve(&self, requested: &str, cursors: &Cursors) -> Result<Resolution, ResolveError> {
        let mut candidates = Vec::new();
        let mut rotation_nodes = Vec::new();
        self.flatten(requested, cursors, &mut candidates, &mut rotation_nodes)?;
        Ok(Resolution { requested: requested.to_string(), candidates, rotation_nodes })
    }

    fn flatten(
        &self,
        name: &str,
        cursors: &Cursors,
        out: &mut Vec<Candidate>,
        rot: &mut Vec<String>,
    ) -> Result<(), ResolveError> {
        if let Some(target) = self.cfg.aliases.get(name) {
            return self.flatten(target, cursors, out, rot);
        }
        if let Some(g) = self.cfg.groups.get(name) {
            let ordered: Vec<String> = match g.strategy {
                FailoverStrategy::Ordered => g.members.clone(),
                FailoverStrategy::RoundRobin => {
                    note_rotation(rot, name);
                    rotate(&g.members, *cursors.get(name).unwrap_or(&0))
                }
            };
            for m in &ordered {
                self.flatten(m, cursors, out, rot)?;
            }
            return Ok(());
        }
        if let Some(b) = self.cfg.buckets.get(name) {
            let accounts: Vec<String> = match b.strategy {
                BucketStrategy::Sticky => b.accounts.clone(),
                BucketStrategy::RoundRobin => {
                    note_rotation(rot, name);
                    rotate(&b.accounts, *cursors.get(name).unwrap_or(&0))
                }
            };
            let md = &self.cfg.models[&b.model]; // load-validated concrete
            for a in accounts {
                out.push(Candidate {
                    provider: md.provider.clone(),
                    model: md.model.clone(),
                    account: Some(a),
                    metadata: md.metadata.clone(),
                });
            }
            return Ok(());
        }
        if let Some(m) = self.cfg.models.get(name) {
            out.push(Candidate {
                provider: m.provider.clone(),
                model: m.model.clone(),
                account: None,
                metadata: m.metadata.clone(),
            });
            return Ok(());
        }
        Err(ResolveError::UnknownName(name.to_string()))
    }
}

fn kinds_of(cfg: &Config, name: &str) -> Vec<&'static str> {
    let mut kinds = Vec::new();
    if cfg.aliases.contains_key(name) {
        kinds.push("alias");
    }
    if cfg.groups.contains_key(name) {
        kinds.push("group");
    }
    if cfg.buckets.contains_key(name) {
        kinds.push("bucket");
    }
    if cfg.models.contains_key(name) {
        kinds.push("model");
    }
    kinds
}

/// Outgoing edges of a graph node. Buckets point at a concrete model
/// (terminal by validation) and models are terminal, so only aliases and
/// groups contribute edges.
fn edges<'a>(cfg: &'a Config, name: &str) -> Vec<&'a str> {
    if let Some(t) = cfg.aliases.get(name) {
        return vec![t.as_str()];
    }
    if let Some(g) = cfg.groups.get(name) {
        return g.members.iter().map(|s| s.as_str()).collect();
    }
    Vec::new()
}

#[derive(Clone, Copy, PartialEq)]
enum VisitState {
    Visiting,
    Done,
}

fn check_cycles(cfg: &Config) -> Result<(), LoadError> {
    fn visit(
        cfg: &Config,
        name: &str,
        state: &mut BTreeMap<String, VisitState>,
        path: &mut Vec<String>,
    ) -> Result<(), LoadError> {
        match state.get(name) {
            Some(VisitState::Done) => return Ok(()), // shared DAG node: fine
            Some(VisitState::Visiting) => {
                let start = path.iter().position(|p| p == name).expect("on path");
                let mut cycle: Vec<String> = path[start..].to_vec();
                cycle.push(name.to_string());
                return Err(LoadError::Cycle { path: cycle });
            }
            None => {}
        }
        state.insert(name.to_string(), VisitState::Visiting);
        path.push(name.to_string());
        for next in edges(cfg, name) {
            visit(cfg, next, state, path)?;
        }
        path.pop();
        state.insert(name.to_string(), VisitState::Done);
        Ok(())
    }

    let mut state = BTreeMap::new();
    let mut path = Vec::new();
    let roots: Vec<String> = cfg
        .aliases
        .keys()
        .chain(cfg.groups.keys())
        .chain(cfg.buckets.keys())
        .chain(cfg.models.keys())
        .cloned()
        .collect();
    for name in roots {
        visit(cfg, &name, &mut state, &mut path)?;
    }
    Ok(())
}

fn rotate(items: &[String], cursor: u64) -> Vec<String> {
    let n = items.len();
    debug_assert!(n > 0, "empty lists rejected at load");
    let k = (cursor % n as u64) as usize;
    items[k..].iter().chain(items[..k].iter()).cloned().collect()
}

fn note_rotation(rot: &mut Vec<String>, name: &str) {
    if !rot.iter().any(|r| r == name) {
        rot.push(name.to_string());
    }
}
