//! Cargo task entry point for Smith.

use std::{
    env,
    error::Error,
    fmt, io,
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
    MetadataDecode(serde_json::Error),
    InvalidMetadata(&'static str),
    Pup(GateError),
    Violations(Vec<String>),
}

impl fmt::Display for ArchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Metadata(error) => write!(formatter, "could not read Cargo metadata: {error}"),
            Self::MetadataFailed(error) => write!(formatter, "Cargo metadata failed: {error}"),
            Self::MetadataDecode(error) => {
                write!(formatter, "could not decode Cargo metadata: {error}")
            }
            Self::InvalidMetadata(reason) => {
                write!(formatter, "Cargo metadata was invalid: {reason}")
            }
            Self::Pup(error) => write!(formatter, "cargo-pup {error}"),
            Self::Violations(violations) => write!(formatter, "{}", violations.join("\n")),
        }
    }
}

impl Error for ArchError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Metadata(error) => Some(error),
            Self::MetadataDecode(error) => Some(error),
            Self::Pup(error) => Some(error),
            Self::MetadataFailed(_) | Self::InvalidMetadata(_) | Self::Violations(_) => None,
        }
    }
}

struct Package {
    name: String,
    dependencies: Vec<Dependency>,
}

struct Dependency {
    name: String,
    kind: DependencyKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DependencyKind {
    Normal,
    Development,
    Build,
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
        Some("print-modules") => match run_print_modules() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("xtask print-modules: {error}");
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
    eprintln!("usage: cargo run -p xtask -- <check|arch|pup|print-modules>");
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

#[expect(
    clippy::print_stdout,
    reason = "The command is a developer-facing module inventory."
)]
fn run_print_modules() -> Result<(), ArchError> {
    for package in cargo_metadata()? {
        println!("{}", crate_root_name(&package.name));
    }

    run_cargo(&[PINNED_NIGHTLY, "pup", "print-modules"]).map_err(ArchError::Pup)
}

fn crate_root_name(package_name: &str) -> String {
    match package_name {
        "smith-cli" => "smith".to_owned(),
        _ => package_name.replace('-', "_"),
    }
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
    let violations = dependency_violations(&packages);

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
    let metadata: serde_json::Value =
        serde_json::from_str(metadata).map_err(ArchError::MetadataDecode)?;
    let packages = metadata
        .get("packages")
        .and_then(serde_json::Value::as_array)
        .ok_or(ArchError::InvalidMetadata("packages were absent"))?;

    packages
        .iter()
        .map(|package| {
            let dependencies = package
                .get("dependencies")
                .and_then(serde_json::Value::as_array)
                .ok_or(ArchError::InvalidMetadata(
                    "package dependencies were absent",
                ))?;
            Ok(Package {
                name: package
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(ArchError::InvalidMetadata("package name was absent"))?
                    .to_owned(),
                dependencies: dependencies
                    .iter()
                    .map(|dependency| {
                        Ok(Dependency {
                            name: dependency
                                .get("name")
                                .and_then(serde_json::Value::as_str)
                                .ok_or(ArchError::InvalidMetadata("dependency name was absent"))?
                                .to_owned(),
                            kind: dependency_kind(dependency)?,
                        })
                    })
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect()
}

fn dependency_kind(dependency: &serde_json::Value) -> Result<DependencyKind, ArchError> {
    match dependency.get("kind") {
        Some(serde_json::Value::Null) | None => Ok(DependencyKind::Normal),
        Some(serde_json::Value::String(kind)) => match kind.as_str() {
            "dev" => Ok(DependencyKind::Development),
            "build" => Ok(DependencyKind::Build),
            _ => Err(ArchError::InvalidMetadata("dependency kind was unknown")),
        },
        Some(_) => Err(ArchError::InvalidMetadata("dependency kind was invalid")),
    }
}

fn dependency_violations(packages: &[Package]) -> Vec<String> {
    let mut violations = Vec::new();

    for package in packages {
        let Some(rule) = ARCHITECTURE.iter().find(|rule| rule.name == package.name) else {
            violations.push(format!(
                "ARCH VIOLATION: {} has no dependency rule in SPEC §2.2",
                package.name
            ));
            continue;
        };

        for dependency in &package.dependencies {
            if dependency.kind == DependencyKind::Normal
                && ARCHITECTURE.iter().any(|rule| rule.name == dependency.name)
                && !rule
                    .allowed_internal_dependencies
                    .contains(&dependency.name.as_str())
            {
                violations.push(format!(
                    "ARCH VIOLATION: {} -> {} is forbidden by SPEC §2.2",
                    package.name, dependency.name
                ));
            }
        }
    }

    violations.extend(
        ARCHITECTURE
            .iter()
            .filter(|rule| !packages.iter().any(|package| package.name == rule.name))
            .map(|rule| {
                format!(
                    "ARCH VIOLATION: required workspace package {} is absent from Cargo metadata",
                    rule.name
                )
            }),
    );
    violations
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "Test fixtures use unwrap so setup failures report their exact operation."
)]
mod tests {
    use super::{
        ARCHITECTURE, ArchError, Dependency, DependencyKind, GateError, Package, crate_root_name,
        dependency_violations, parse_metadata, run_check,
    };

    fn complete_workspace() -> Vec<Package> {
        ARCHITECTURE
            .iter()
            .map(|rule| Package {
                name: rule.name.to_owned(),
                dependencies: Vec::new(),
            })
            .collect()
    }

    #[test]
    fn check_runs_architecture_gates_in_order() {
        let mut invocations = Vec::new();

        let result = run_check(|arguments| {
            invocations.push(arguments);
            Ok(())
        });

        assert!(result.is_ok());
        assert_eq!(
            invocations,
            [
                ["fmt", "--check"].as_slice(),
                [
                    "clippy",
                    "--workspace",
                    "--all-targets",
                    "--all-features",
                    "--",
                    "-D",
                    "warnings",
                ]
                .as_slice(),
                ["run", "-p", "xtask", "--", "arch"].as_slice(),
                ["run", "-p", "xtask", "--", "pup"].as_slice(),
                ["nextest", "run", "--workspace"].as_slice(),
                ["test", "--doc", "--workspace"].as_slice(),
            ]
        );
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
        let metadata = r#"{"packages":[{"name":"smith-core","dependencies":[{"name":"smith","kind":null}],"manifest_path":"C:\\smith-core\\Cargo.toml"}]}"#;

        let packages = parse_metadata(metadata).unwrap();

        assert_eq!(packages[0].name, "smith-core");
        assert_eq!(packages[0].dependencies[0].name, "smith");
        assert_eq!(packages[0].dependencies[0].kind, DependencyKind::Normal);
    }

    #[test]
    fn metadata_parser_reads_fields_by_json_structure() {
        let metadata = r#"{"packages":[{"name":"smith-core","description":"\"dependencies\": []","dependencies":[{"name":"smith","kind":null}]}]}"#;

        let packages = parse_metadata(metadata).unwrap();

        assert_eq!(packages[0].dependencies[0].name, "smith");
    }

    #[test]
    fn metadata_parser_preserves_non_normal_dependency_kinds() {
        let metadata = r#"{"packages":[{"name":"smith-core","dependencies":[{"name":"smith-ai","kind":"dev"},{"name":"smith-ai","kind":"build"}]}]}"#;

        let packages = parse_metadata(metadata).unwrap();

        assert_eq!(
            packages[0].dependencies[0].kind,
            DependencyKind::Development
        );
        assert_eq!(packages[0].dependencies[1].kind, DependencyKind::Build);
    }

    #[test]
    fn module_inventory_uses_rust_crate_names() {
        assert_eq!(crate_root_name("smith-core"), "smith_core");
    }

    #[test]
    fn module_inventory_uses_the_cli_binary_crate_name() {
        assert_eq!(crate_root_name("smith-cli"), "smith");
    }

    #[test]
    fn arch_rejects_forbidden_internal_dependency() {
        let mut packages = complete_workspace();
        let package = packages
            .iter_mut()
            .find(|package| package.name == "smith-core")
            .unwrap();
        package.dependencies = vec![
            Dependency {
                name: "smith-ai".to_owned(),
                kind: DependencyKind::Normal,
            },
            Dependency {
                name: "smith-tui".to_owned(),
                kind: DependencyKind::Normal,
            },
        ];

        assert_eq!(
            dependency_violations(&packages),
            [
                "ARCH VIOLATION: smith-core -> smith-ai is forbidden by SPEC §2.2",
                "ARCH VIOLATION: smith-core -> smith-tui is forbidden by SPEC §2.2",
            ]
        );
    }

    #[test]
    fn arch_allows_dev_and_build_dependencies() {
        let mut packages = complete_workspace();
        let package = packages
            .iter_mut()
            .find(|package| package.name == "smith-core")
            .unwrap();
        package.dependencies = vec![
            Dependency {
                name: "smith-ai".to_owned(),
                kind: DependencyKind::Development,
            },
            Dependency {
                name: "smith-ai".to_owned(),
                kind: DependencyKind::Build,
            },
        ];

        assert!(dependency_violations(&packages).is_empty());
    }

    #[test]
    fn arch_rejects_an_unlisted_workspace_package() {
        let mut packages = complete_workspace();
        packages.push(Package {
            name: "new-workspace-package".to_owned(),
            dependencies: Vec::new(),
        });

        assert_eq!(
            dependency_violations(&packages),
            ["ARCH VIOLATION: new-workspace-package has no dependency rule in SPEC §2.2"]
        );
    }

    #[test]
    fn arch_rejects_a_missing_required_workspace_package() {
        let mut packages = complete_workspace();
        packages.retain(|package| package.name != "xtask");

        assert_eq!(
            dependency_violations(&packages),
            ["ARCH VIOLATION: required workspace package xtask is absent from Cargo metadata"]
        );
    }

    #[test]
    fn malformed_metadata_is_rejected() {
        assert!(matches!(
            parse_metadata("{}"),
            Err(ArchError::InvalidMetadata(_))
        ));

        assert!(matches!(
            parse_metadata("{"),
            Err(ArchError::MetadataDecode(_))
        ));
    }
}
