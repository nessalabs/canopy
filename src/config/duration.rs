//! `"500ms"`, `"5s"`, `"2m"` — the duration spelling `canopy.yaml` uses.
//!
//! Deliberately narrow: the same three units the TypeScript `parseDuration` accepts
//! (`packages/shared/src/canopy-yaml.ts`), so a file that is valid for the daemon is valid
//! here. `"5"` and `"5h"` are errors rather than guesses.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

/// A duration in milliseconds. `Copy`, because it is passed around constantly.
// Doc comments on this type are published: they become the TypeScript binding's JSDoc and the
// JSON Schema's description. The schema itself is hand-written in `super::schema`, because it
// has to describe the spelling `parse` accepts rather than the `u64` underneath.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
// The inner field is milliseconds, but a `canopy.yaml` and a `--json` payload both carry the
// string spelling, so that is what the binding has to say.
pub struct Duration(#[cfg_attr(feature = "ts", ts(type = "string"))] u64);

impl Duration {
    pub const ZERO: Duration = Duration(0);

    pub const fn from_millis(ms: u64) -> Duration {
        Duration(ms)
    }

    pub const fn from_secs(secs: u64) -> Duration {
        Duration(secs * 1000)
    }

    pub const fn as_millis(self) -> u64 {
        self.0
    }

    pub const fn as_std(self) -> std::time::Duration {
        std::time::Duration::from_millis(self.0)
    }

    /// Parses `<digits><ms|s|m>`. The error text is what the user sees in a lint message.
    pub fn parse(text: &str) -> Result<Duration, DurationError> {
        let digits = text.trim_end_matches(|c: char| c.is_ascii_alphabetic());
        let unit = &text[digits.len()..];
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(DurationError(text.to_owned()));
        }
        let value: u64 = digits.parse().map_err(|_| DurationError(text.to_owned()))?;
        let millis = match unit {
            "ms" => value,
            "s" => value.checked_mul(1000).ok_or_else(|| DurationError(text.to_owned()))?,
            "m" => value.checked_mul(60_000).ok_or_else(|| DurationError(text.to_owned()))?,
            // A bare number is rejected rather than assumed to be seconds: `timeout: 5` meaning
            // 5ms in one tool and 5s in another is exactly the kind of thing that wastes an hour.
            _ => return Err(DurationError(text.to_owned())),
        };
        Ok(Duration(millis))
    }
}

impl fmt::Display for Duration {
    /// Round-trips: the shortest spelling that parses back to the same value.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ms = self.0;
        if ms != 0 && ms.is_multiple_of(60_000) {
            write!(f, "{}m", ms / 60_000)
        } else if ms != 0 && ms.is_multiple_of(1000) {
            write!(f, "{}s", ms / 1000)
        } else {
            write!(f, "{ms}ms")
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurationError(String);

impl fmt::Display for DurationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?} is not a duration like 5s, 500ms or 2m", self.0)
    }
}

impl std::error::Error for DurationError {}

impl<'de> Deserialize<'de> for Duration {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Duration::parse(&text).map_err(D::Error::custom)
    }
}

impl Serialize for Duration {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::*;

    #[rstest]
    #[case("500ms", 500)]
    #[case("0ms", 0)]
    #[case("5s", 5_000)]
    #[case("0s", 0)]
    #[case("2m", 120_000)]
    #[case("90s", 90_000)]
    fn parses_the_three_units(#[case] text: &str, #[case] millis: u64) {
        assert_eq!(Duration::parse(text).unwrap().as_millis(), millis);
    }

    #[rstest]
    // A bare number is ambiguous, so it is an error rather than a guess.
    #[case("5")]
    // Hours are not in the grammar the daemon accepts; silently supporting them here would
    // make a file that works with canopywt fail in Canopy.
    #[case("5h")]
    #[case("")]
    #[case("s")]
    #[case("ms")]
    #[case("-5s")]
    // `u64::from_str` accepts a leading `+`, so without an explicit digits-only check this
    // would quietly parse as 5 seconds.
    #[case("+5s")]
    #[case("5 s")]
    #[case("5.5s")]
    #[case("five")]
    #[case("5sec")]
    fn rejects_everything_else(#[case] text: &str) {
        assert!(Duration::parse(text).is_err(), "{text:?} should not parse");
    }

    #[rstest]
    #[case("500ms")]
    #[case("5s")]
    #[case("2m")]
    #[case("0ms")]
    #[case("90s")]
    fn display_round_trips(#[case] text: &str) {
        let parsed = Duration::parse(text).unwrap();
        assert_eq!(Duration::parse(&parsed.to_string()).unwrap(), parsed);
    }

    #[test]
    fn display_picks_the_shortest_spelling() {
        assert_eq!(Duration::from_millis(120_000).to_string(), "2m");
        assert_eq!(Duration::from_millis(5_000).to_string(), "5s");
        assert_eq!(Duration::from_millis(500).to_string(), "500ms");
        assert_eq!(Duration::from_millis(0).to_string(), "0ms");
        // 90s is not a whole number of minutes, so it stays in seconds.
        assert_eq!(Duration::from_millis(90_000).to_string(), "90s");
    }

    #[rstest]
    // Each unit multiplies by a different factor, so each needs its own overflow guard.
    #[case(&format!("{}m", u64::MAX))]
    #[case(&format!("{}s", u64::MAX))]
    // More digits than a u64 can hold at all: the parse itself fails before any multiply.
    #[case("99999999999999999999999999ms")]
    fn an_absurd_value_errors_instead_of_wrapping(#[case] text: &str) {
        assert!(Duration::parse(text).is_err(), "{text:?} should not parse");
    }

    #[test]
    fn the_largest_representable_value_still_parses() {
        // The complement of the overflow tests: a guard that rejected everything large would
        // otherwise pass them all.
        assert_eq!(Duration::parse(&format!("{}ms", u64::MAX)).unwrap().as_millis(), u64::MAX);
    }

    #[test]
    fn a_duration_deserializes_from_yaml_and_reports_a_useful_error() {
        #[derive(Debug, serde::Deserialize)]
        struct Holder {
            timeout: Duration,
        }
        assert_eq!(serde_saphyr::from_str::<Holder>("timeout: 2m").unwrap().timeout.as_millis(), 120_000);

        // The message a user sees when they write `timeout: 5` has to name the grammar.
        let error = serde_saphyr::from_str::<Holder>("timeout: \"5\"").unwrap_err().to_string();
        assert!(error.contains("5s"), "the error should show the accepted spelling: {error}");
    }

    #[test]
    fn a_duration_serializes_back_to_its_spelling() {
        #[derive(serde::Serialize)]
        struct Holder {
            timeout: Duration,
        }
        let json = serde_json::to_value(Holder { timeout: Duration::from_secs(90) }).unwrap();
        assert_eq!(json["timeout"], "90s");
    }

    #[test]
    fn as_std_converts_without_losing_the_value() {
        assert_eq!(Duration::from_secs(2).as_std(), std::time::Duration::from_millis(2000));
        assert_eq!(Duration::ZERO.as_std(), std::time::Duration::ZERO);
    }
}
