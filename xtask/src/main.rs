//! Cargo task entry point for Smith.

use std::{
    env,
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

const CHECK_GATES: [Gate; 6] = [
    Gate::new("fmt", &["fmt", "--check"]),
    Gate::new(
        "clippy",
        &[
            "clippy",
            "--workspace",
            "--all-targets",
            "--all-features",
            "--",
            "-D",
            "warnings",
        ],
    ),
    Gate::new("arch", &["run", "-p", "xtask", "--", "arch"]),
    Gate::new("pup", &["run", "-p", "xtask", "--", "pup"]),
    Gate::new("test", &["nextest", "run", "--workspace"]),
    Gate::new("doc", &["test", "--doc", "--workspace"]),
];

const ARCHITECTURE: [CrateRule; 7] = [
    CrateRule::new("smith", &[]),
    CrateRule::new("smith-core", &["smith"]),
    CrateRule::new("smith-ai", &["smith"]),
    CrateRule::new("smith-tui", &["smith"]),
    CrateRule::new(
        "smith-harness",
        &["smith", "smith-core", "smith-ai", "smith-tui"],
    ),
    CrateRule::new("smith-cli", &["smith", "smith-harness"]),
    CrateRule::new("xtask", &[]),
];

const PINNED_NIGHTLY: &str = "+nightly-2026-01-22";

struct Gate {
    name: &'static str,
    arguments: &'static [&'static str],
}

impl Gate {
    const fn new(name: &'static str, arguments: &'static [&'static str]) -> Self {
        Self { name, arguments }
    }
}

struct CrateRule {
    name: &'static str,
    allowed_internal_dependencies: &'static [&'static str],
}

impl CrateRule {
    const fn new(
        name: &'static str,
        allowed_internal_dependencies: &'static [&'static str],
    ) -> Self {
        Self {
            name,
            allowed_internal_dependencies,
        }
    }
}

#[derive(Debug)]
enum GateError {
    Spawn(io::Error),
    Failed,
}

impl fmt::Display for GateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) => write!(formatter, "could not start cargo: {error}"),
            Self::Failed => formatter.write_str("returned a non-zero status"),
        }
    }
}

impl Error for GateError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Spawn(error) => Some(error),
            Self::Failed => None,
        }
    }
}

struct CheckError {
    gate: &'static str,
    source: GateError,
}

impl fmt::Display for CheckError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} gate {}", self.gate, self.source)
    }
}

#[derive(Debug)]
enum ArchError {
    Metadata(io::Error),
    MetadataFailed(String),
    InvalidMetadata(&'static str),
    Source { path: PathBuf, source: io::Error },
    Violations(Vec<String>),
}

impl fmt::Display for ArchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Metadata(error) => write!(formatter, "could not read Cargo metadata: {error}"),
            Self::MetadataFailed(error) => write!(formatter, "Cargo metadata failed: {error}"),
            Self::InvalidMetadata(reason) => {
                write!(formatter, "Cargo metadata was invalid: {reason}")
            }
            Self::Source { path, source } => {
                write!(formatter, "could not inspect {}: {source}", path.display())
            }
            Self::Violations(violations) => write!(formatter, "{}", violations.join("\n")),
        }
    }
}

impl Error for ArchError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Metadata(error) => Some(error),
            Self::Source { source, .. } => Some(source),
            Self::MetadataFailed(_) | Self::InvalidMetadata(_) | Self::Violations(_) => None,
        }
    }
}

struct Package {
    name: String,
    dependencies: Vec<String>,
    manifest_path: PathBuf,
}

#[expect(
    clippy::print_stderr,
    reason = "A failed gate needs a concise diagnostic before xtask exits non-zero."
)]
fn main() -> ExitCode {
    let mut arguments = env::args().skip(1);
    let command = arguments.next();

    if arguments.next().is_some() {
        return usage();
    }

    match command.as_deref() {
        Some("check") => match run_check(run_cargo) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("xtask check: {error}");
                ExitCode::FAILURE
            }
        },
        Some("arch") => match run_arch() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("xtask arch: {error}");
                ExitCode::FAILURE
            }
        },
        Some("pup") => match run_pup() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("xtask pup: {error}");
                ExitCode::FAILURE
            }
        },
        _ => usage(),
    }
}

#[expect(
    clippy::print_stderr,
    reason = "Usage is an interactive command-line diagnostic."
)]
fn usage() -> ExitCode {
    eprintln!("usage: cargo run -p xtask -- <check|arch|pup>");
    ExitCode::FAILURE
}

fn run_check(
    mut run_gate: impl FnMut(&'static [&'static str]) -> Result<(), GateError>,
) -> Result<(), CheckError> {
    for gate in CHECK_GATES {
        run_gate(gate.arguments).map_err(|source| CheckError {
            gate: gate.name,
            source,
        })?;
    }

    Ok(())
}

fn run_pup() -> Result<(), GateError> {
    run_cargo(&[PINNED_NIGHTLY, "pup"])
}

fn run_cargo(arguments: &[&str]) -> Result<(), GateError> {
    let status = Command::new("cargo")
        .args(arguments)
        .status()
        .map_err(GateError::Spawn)?;

    if status.success() {
        Ok(())
    } else {
        Err(GateError::Failed)
    }
}

fn run_arch() -> Result<(), ArchError> {
    let packages = cargo_metadata()?;
    let mut violations = dependency_violations(&packages);

    for package in packages {
        violations.extend(source_violations(&package)?);
    }

    if violations.is_empty() {
        Ok(())
    } else {
        Err(ArchError::Violations(violations))
    }
}

fn cargo_metadata() -> Result<Vec<Package>, ArchError> {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .output()
        .map_err(ArchError::Metadata)?;

    if !output.status.success() {
        return Err(ArchError::MetadataFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }

    parse_metadata(&String::from_utf8_lossy(&output.stdout))
}

fn parse_metadata(metadata: &str) -> Result<Vec<Package>, ArchError> {
    let packages = json_array_field(metadata, "packages")?;
    json_objects(packages)
        .into_iter()
        .map(|package| {
            let dependencies = json_array_field(package, "dependencies")?;
            Ok(Package {
                name: json_string_field(package, "name")?.to_owned(),
                dependencies: json_objects(dependencies)
                    .into_iter()
                    .map(|dependency| json_string_field(dependency, "name").map(str::to_owned))
                    .collect::<Result<_, _>>()?,
                manifest_path: PathBuf::from(json_string_field(package, "manifest_path")?),
            })
        })
        .collect()
}

fn json_array_field<'a>(object: &'a str, field: &str) -> Result<&'a str, ArchError> {
    let field_start = object
        .find(&format!("\"{field}\""))
        .ok_or(ArchError::InvalidMetadata("required field was absent"))?;
    let value_start = object[field_start..]
        .find('[')
        .map(|offset| field_start + offset)
        .ok_or(ArchError::InvalidMetadata("array field was malformed"))?;
    json_balanced(object, value_start, b'[', b']')
}

fn json_string_field<'a>(object: &'a str, field: &str) -> Result<&'a str, ArchError> {
    let field_start = object
        .find(&format!("\"{field}\""))
        .ok_or(ArchError::InvalidMetadata("required field was absent"))?;
    let value_start = object[field_start..]
        .find(':')
        .map(|offset| field_start + offset + 1)
        .ok_or(ArchError::InvalidMetadata("string field was malformed"))?;
    let value = object[value_start..].trim_start();
    let value = value
        .strip_prefix('"')
        .ok_or(ArchError::InvalidMetadata("string field was not a string"))?;
    let value_end = value
        .find('"')
        .ok_or(ArchError::InvalidMetadata("string field was unterminated"))?;

    if value[..value_end].contains('\\') {
        return Err(ArchError::InvalidMetadata(
            "escaped JSON strings are not supported by the metadata reader",
        ));
    }

    Ok(&value[..value_end])
}

fn json_balanced(value: &str, start: usize, opening: u8, closing: u8) -> Result<&str, ArchError> {
    let bytes = value.as_bytes();
    let mut depth = 0;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, byte) in bytes[start..].iter().enumerate() {
        match *byte {
            b'\\' if in_string => escaped = !escaped,
            b'"' if !escaped => in_string = !in_string,
            byte if !in_string && byte == opening => depth += 1,
            byte if !in_string && byte == closing => {
                depth -= 1;
                if depth == 0 {
                    return Ok(&value[start + 1..start + offset]);
                }
            }
            _ => escaped = false,
        }
    }

    Err(ArchError::InvalidMetadata(
        "JSON collection was unterminated",
    ))
}

fn json_objects(array: &str) -> Vec<&str> {
    let mut objects = Vec::new();
    let bytes = array.as_bytes();
    let mut start = None;
    let mut depth = 0;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, byte) in bytes.iter().enumerate() {
        match *byte {
            b'\\' if in_string => escaped = !escaped,
            b'"' if !escaped => in_string = !in_string,
            b'{' if !in_string => {
                if depth == 0 {
                    start = Some(offset + 1);
                }
                depth += 1;
            }
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0
                    && let Some(start) = start
                {
                    objects.push(&array[start..offset]);
                }
            }
            _ => escaped = false,
        }
    }

    objects
}

fn dependency_violations(packages: &[Package]) -> Vec<String> {
    packages
        .iter()
        .filter_map(|package| {
            let rule = ARCHITECTURE.iter().find(|rule| rule.name == package.name)?;
            let forbidden = package.dependencies.iter().find(|dependency| {
                ARCHITECTURE
                    .iter()
                    .any(|rule| rule.name == dependency.as_str())
                    && !rule
                        .allowed_internal_dependencies
                        .contains(&dependency.as_str())
            })?;
            Some(format!(
                "ARCH VIOLATION: {} -> {forbidden} is forbidden by SPEC §2.2",
                package.name
            ))
        })
        .collect()
}

fn source_violations(package: &Package) -> Result<Vec<String>, ArchError> {
    let source_root = package
        .manifest_path
        .parent()
        .ok_or(ArchError::InvalidMetadata("manifest path had no parent"))?
        .join("src");
    let mut source_files = Vec::new();
    collect_rust_files(&source_root, &mut source_files)?;

    let mut violations = Vec::new();
    for path in source_files {
        let source = fs::read_to_string(&path).map_err(|source| ArchError::Source {
            path: path.clone(),
            source,
        })?;
        let display_path = path.display();

        if path.file_name().is_some_and(|name| name == "mod.rs") && !is_hygienic_mod_file(&source) {
            violations.push(format!(
                "ARCH VIOLATION: {display_path} contains more than module declarations and re-exports"
            ));
        }
        if contains_wildcard_import(&source) {
            violations.push(format!(
                "ARCH VIOLATION: {display_path} contains a wildcard import"
            ));
        }
        if contains_public_module(&source) {
            violations.push(format!(
                "ARCH VIOLATION: {display_path} exposes an implementation module with `pub mod`"
            ));
        }
    }

    Ok(violations)
}

fn collect_rust_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), ArchError> {
    if !directory.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(directory).map_err(|source| ArchError::Source {
        path: directory.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| ArchError::Source {
            path: directory.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        if path.is_dir() {
            collect_rust_files(&path, files)?;
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
    Ok(())
}

fn is_hygienic_mod_file(source: &str) -> bool {
    source.lines().all(|line| {
        let line = line.trim();
        line.is_empty()
            || line.starts_with("//")
            || line.starts_with("#![")
            || line.starts_with("#[")
            || (line.ends_with(';')
                && (line.starts_with("mod ")
                    || line.starts_with("pub mod ")
                    || line.starts_with("pub(crate) mod ")
                    || line.starts_with("pub use ")
                    || line.starts_with("pub(crate) use ")))
    })
}

fn contains_wildcard_import(source: &str) -> bool {
    source.split(';').map(str::trim_start).any(|statement| {
        (statement.starts_with("use ") || statement.starts_with("pub use "))
            && statement.contains('*')
    })
}

fn contains_public_module(source: &str) -> bool {
    source
        .lines()
        .any(|line| line.trim_start().starts_with("pub mod "))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "Test fixtures use unwrap so setup failures report their exact operation."
)]
mod tests {
    use super::{
        ARCHITECTURE, ArchError, GateError, Package, dependency_violations, parse_metadata,
        run_check, source_violations,
    };
    use std::{
        env, fs,
        path::PathBuf,
        process,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn check_runs_architecture_gates_in_order() {
        let mut invocations = Vec::new();

        let result = run_check(|arguments| {
            invocations.push(arguments);
            Ok(())
        });

        assert!(result.is_ok());
        assert_eq!(invocations[2], ["run", "-p", "xtask", "--", "arch"]);
        assert_eq!(invocations[3], ["run", "-p", "xtask", "--", "pup"]);
    }

    #[test]
    fn check_stops_when_pup_fails() {
        let mut invocations = Vec::new();
        let mut calls = 0;

        let result = run_check(|arguments| {
            invocations.push(arguments);
            calls += 1;
            if calls == 4 {
                Err(GateError::Failed)
            } else {
                Ok(())
            }
        });

        assert!(matches!(result, Err(error) if error.gate == "pup"));
        assert_eq!(invocations.len(), 4);
    }

    #[test]
    fn metadata_parser_finds_direct_dependencies() {
        let metadata = r#"{"packages":[{"name":"smith-core","dependencies":[{"name":"smith"}],"manifest_path":"/tmp/smith-core/Cargo.toml"}]}"#;

        let packages = parse_metadata(metadata).unwrap();

        assert_eq!(packages[0].name, "smith-core");
        assert_eq!(packages[0].dependencies, ["smith"]);
    }

    #[test]
    fn arch_rejects_forbidden_internal_dependency() {
        let package = Package {
            name: "smith-core".to_owned(),
            dependencies: vec!["smith-ai".to_owned()],
            manifest_path: PathBuf::from("/tmp/smith-core/Cargo.toml"),
        };

        assert_eq!(ARCHITECTURE.len(), 7);
        assert_eq!(
            dependency_violations(&[package]),
            ["ARCH VIOLATION: smith-core -> smith-ai is forbidden by SPEC §2.2"]
        );
    }

    #[test]
    fn arch_rejects_source_forbidden_list() {
        let directory = temporary_directory();
        let source_directory = directory.join("src");
        fs::create_dir_all(&source_directory).unwrap();
        fs::write(
            source_directory.join("mod.rs"),
            "pub mod child;\nfn hidden() {}\n",
        )
        .unwrap();
        fs::write(
            source_directory.join("lib.rs"),
            "use dependency::*;\npub mod implementation;\n",
        )
        .unwrap();
        let package = Package {
            name: "smith".to_owned(),
            dependencies: Vec::new(),
            manifest_path: directory.join("Cargo.toml"),
        };

        let result = source_violations(&package);
        fs::remove_dir_all(&directory).unwrap();

        let violations = result.unwrap();
        assert_eq!(violations.len(), 4);
        assert!(
            violations
                .iter()
                .any(|violation| violation.contains("mod.rs"))
        );
        assert!(
            violations
                .iter()
                .any(|violation| violation.contains("wildcard import"))
        );
        assert!(
            violations
                .iter()
                .any(|violation| violation.contains("pub mod"))
        );
    }

    #[test]
    fn malformed_metadata_is_rejected() {
        assert!(matches!(
            parse_metadata("{}"),
            Err(ArchError::InvalidMetadata(_))
        ));
    }

    fn temporary_directory() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!("smith-xtask-{nonce}-{}", process::id()));
        fs::create_dir(&directory).unwrap();
        directory
    }
}
