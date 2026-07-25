//! Cargo task entry point for Smith.

use std::{
    env,
    error::Error,
    fmt, io,
    process::{Command, ExitCode},
};

const CHECK_GATES: [Gate; 4] = [
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
    Gate::new("test", &["nextest", "run", "--workspace"]),
    Gate::new("doc", &["test", "--doc", "--workspace"]),
];

struct Gate {
    name: &'static str,
    arguments: &'static [&'static str],
}

impl Gate {
    const fn new(name: &'static str, arguments: &'static [&'static str]) -> Self {
        Self { name, arguments }
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

#[expect(
    clippy::print_stderr,
    reason = "A failed gate needs a concise diagnostic before xtask exits non-zero."
)]
fn main() -> ExitCode {
    let mut arguments = env::args().skip(1);
    let command = arguments.next();

    if command.as_deref() == Some("check") && arguments.next().is_none() {
        return match run_check(run_cargo) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("xtask check: {error}");
                ExitCode::FAILURE
            }
        };
    }

    eprintln!("usage: cargo run -p xtask -- check");
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

#[cfg(test)]
mod tests {
    use super::{GateError, run_check};

    #[test]
    fn check_runs_stable_gates_in_order() {
        let mut invocations = Vec::new();

        let result = run_check(|arguments| {
            invocations.push(arguments);
            Ok(())
        });

        assert!(result.is_ok());
        let expected: [&[&str]; 4] = [
            &["fmt", "--check"],
            &[
                "clippy",
                "--workspace",
                "--all-targets",
                "--all-features",
                "--",
                "-D",
                "warnings",
            ],
            &["nextest", "run", "--workspace"],
            &["test", "--doc", "--workspace"],
        ];
        assert_eq!(invocations, expected);
    }

    #[test]
    fn check_stops_when_a_gate_fails() {
        let mut invocations = Vec::new();
        let mut calls = 0;

        let result = run_check(|arguments| {
            invocations.push(arguments);
            calls += 1;
            if calls == 2 {
                Err(GateError::Failed)
            } else {
                Ok(())
            }
        });

        assert!(matches!(result, Err(error) if error.gate == "clippy"));
        let expected: [&[&str]; 2] = [
            &["fmt", "--check"],
            &[
                "clippy",
                "--workspace",
                "--all-targets",
                "--all-features",
                "--",
                "-D",
                "warnings",
            ],
        ];
        assert_eq!(invocations, expected);
    }
}
